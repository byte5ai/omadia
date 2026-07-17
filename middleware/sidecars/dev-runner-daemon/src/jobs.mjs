/**
 * Epic #470 W1 — job registry + the container-lifecycle seam (spec §4, §7).
 *
 * TWO things live here:
 *
 *  1. `JobManager` — the daemon's in-memory registry of live jobs and the
 *     idempotency authority for `POST /v1/jobs`. It fetches the server-derived
 *     policy (via the injected policy client), asks the engine to create the
 *     container, and records the handle. A second create for a live job returns
 *     the EXISTING record and never asks the engine for a second container; a
 *     create already in flight is de-duplicated so two concurrent requests still
 *     produce one container (review lesson: idempotency is a create-time
 *     property, not an after-the-fact cleanup).
 *
 *  2. `ContainerEngine` — the seam the container lifecycle hangs off. This unit
 *     ships the SCAFFOLD; the hardening-clamp unit drops the real dockerode
 *     `create/start` (with the §4 clamp) in behind this same interface, and the
 *     tests here drive a fake. `createDockerEngine` wires a real dockerode client
 *     to dind over TLS and implements `ping` (which `/v1/health` needs now);
 *     the mutating lifecycle methods throw `EngineNotImplementedError` until the
 *     clamp unit fills them, so an accidental early call fails loudly.
 *
 * SEAM CONTRACT — `ContainerEngine.createJobContainer({ jobId, policy,
 * leaseExpiresAt })`: given a job id, the SERVER-DERIVED `DerivedJobPolicy`
 * (image/env/egressAllowlist, fetched by the daemon — never caller-supplied),
 * and the computed lease expiry, create and start ONE hardened container and
 * return its `{ containerId, networkId, volumeName, imageDigest }`. The clamp,
 * per-job network, and workspace volume are the implementation's responsibility;
 * the JobManager only stores what it returns.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { join } from 'node:path';

import Docker from 'dockerode';

import {
  buildContainerCreateOptions,
  buildDindCertsVolumeOptions,
  buildDindCreateOptions,
  buildDindImageStoreVolumeOptions,
  DEV_DOCKER_IN_JOB_LABEL,
  DEV_ROLE_LABEL,
  dindCertsVolumeName,
  dindContainerName,
  dindVolumeName,
  imageDigestOf,
  jobNetworkName,
  jobVolumeName,
  resolveClampLimits,
  resolveDindDiskGb,
  resolveDindImage,
  ROLE_DIND,
  SpecRejectedError,
} from './clamp.mjs';

/**
 * @typedef {import('./policyClient.mjs').DerivedJobPolicy} DerivedJobPolicy
 * @typedef {import('./policyClient.mjs').PolicyClient} PolicyClient
 */

/** The label every job container/network/volume carries — the ground truth the
 *  reaper reconciles against (spec §7: "the label set is the ground truth the
 *  daemon reconciles against"). Kept here so the engine that WRITES them and the
 *  engine method that READS them back share one source of the strings. */
export const JOB_ID_LABEL = 'ai.omadia.dev.jobId';
/** The principal that created the resource; the reaper filters on it so one
 *  daemon deployment never reaps another's jobs on a shared engine. */
export const CREATED_BY_LABEL = 'ai.omadia.dev.createdBy';
/** The ISO-8601 lease expiry, stamped on the container so a restarted daemon can
 *  rebuild lease state from labels alone (spec §7 "state rebuilt from labels"). */
export const LEASE_EXPIRES_LABEL = 'ai.omadia.dev.leaseExpiresAt';

/**
 * A created job container, as the engine reports it back.
 * @typedef {object} JobContainer
 * @property {string} containerId
 * @property {string} networkId
 * @property {string} volumeName
 * @property {string} imageDigest
 * @property {string} [jobId] The job id, so teardown can reconstruct the
 *   deterministically-named DinD sidecar resources without a second lookup.
 * @property {boolean} [dockerInJob] True when this job runs a DinD sidecar; gates
 *   sidecar teardown so a plain job's teardown is byte-identical to before W5.
 */

/**
 * dind reachability + engine version, for `/v1/health`.
 * @typedef {object} EnginePing
 * @property {boolean} reachable
 * @property {string} apiVersion
 */

/**
 * A job container the engine discovered on dind by its label, for boot-time
 * registry rebuild (spec §7: "State rebuilt from container labels on boot").
 * @typedef {object} ManagedContainer
 * @property {string} jobId From the `ai.omadia.dev.jobId` label.
 * @property {string} containerId The real docker id (containers are unnamed).
 * @property {string} leaseExpiresAt From the lease label; '' when the label is absent.
 * @property {string} imageDigest Best-effort digest of the running image; '' if unknown.
 * @property {boolean} running Docker's State === 'running'. A container that has
 *   exited is stale no matter what its lease label says.
 * @property {boolean} dockerInJob From the `ai.omadia.dev.dockerInJob` label:
 *   whether this job also ran a DinD sidecar that must be torn down with it.
 * @property {number} createdAtMs Docker's `Created` timestamp. The container's
 *   real age — the daemon's absolute lifetime is measured from THIS, not from
 *   the adoption, or a restart would hand every job a fresh lifetime and the
 *   `lifetime_exceeded` guard would be defeated by restarting the daemon.
 */

/**
 * A labelled per-job network or volume the engine discovered on dind. The
 * reaper joins these against live jobs to find orphans (spec §7 daemon restart).
 * @typedef {object} ManagedResource
 * @property {string} jobId From the `ai.omadia.dev.jobId` label.
 * @property {string} id The network id or volume name (docker remove accepts either).
 */

/**
 * The full label-derived inventory of what this daemon left on the engine.
 * @typedef {object} ManagedInventory
 * @property {ManagedContainer[]} containers
 * @property {ManagedResource[]} networks
 * @property {ManagedResource[]} volumes
 */

/**
 * The container-lifecycle seam. The clamp/warmer/reaper units implement the
 * mutating methods; this unit provides `ping` and the fake used by tests.
 * @typedef {object} ContainerEngine
 * @property {() => Promise<EnginePing>} ping
 * @property {(args: { jobId: string, policy: DerivedJobPolicy, leaseExpiresAt: string }) => Promise<JobContainer>} createJobContainer
 * @property {(container: JobContainer) => Promise<void>} destroyJobContainer
 * @property {(container: JobContainer, opts: { follow: boolean }) => Promise<import('node:stream').Readable>} streamLogs
 * @property {(refs: readonly string[]) => Promise<string[]>} warmImages
 * @property {() => Promise<ManagedInventory>} listManagedResources List every
 *   container/network/volume carrying THIS daemon's label — the reaper's
 *   reconciliation source for boot rebuild and the orphan sweep.
 */

/**
 * One live job the daemon is tracking.
 * @typedef {object} JobRecord
 * @property {string} jobId
 * @property {JobContainer} container
 * @property {string} leaseExpiresAt
 * @property {string} hardDeadlineAt The daemon-owned absolute deadline. Renewals
 *   can move `leaseExpiresAt`, never this — otherwise a compromised middleware
 *   pins a container forever simply by renewing it, and the reaper's whole
 *   purpose (the daemon is self-authoritative for containers) is defeated.
 */

/**
 * A monotonic-enough clock seam so lease math is deterministic in tests.
 * @typedef {object} Clock
 * @property {() => number} now Milliseconds since the epoch.
 */

/** Raised by an engine method the current unit does not yet implement. The HTTP
 *  layer maps it to 501 so an early call is diagnosable rather than a silent
 *  wrong answer. */
export class EngineNotImplementedError extends Error {
  /** @param {string} method */
  constructor(method) {
    super(`ContainerEngine.${method} is not implemented in this unit (hardening-clamp unit owns it)`);
    this.name = 'EngineNotImplementedError';
    /** @type {string} */
    this.code = 'daemon.engine_not_implemented';
  }
}

/** Raised when a `create` is torn down by a `destroy` that raced it: the DELETE
 *  arrived while the container was still provisioning, so `#provision` destroys
 *  the just-created container instead of registering it and signals the create
 *  caller that its job was cancelled. The HTTP layer maps it to 409. */
export class JobCancelledError extends Error {
  /** @param {string} jobId */
  constructor(jobId) {
    super(`job ${jobId} was deleted while it was being created`);
    this.name = 'JobCancelledError';
    /** @type {string} */
    this.code = 'daemon.job_cancelled';
  }
}

/** Raised when a DELETE's container teardown throws: the engine cleanup failed,
 *  so the job is KEPT in the registry (its handle is the only thing that can retry
 *  the cleanup) rather than forgotten with a live container leaking behind it. The
 *  HTTP layer maps it to 502 so the caller knows the job is still tracked and the
 *  DELETE can be retried. */
export class JobCleanupError extends Error {
  /** @param {string} jobId @param {unknown} cause */
  constructor(jobId, cause) {
    super(`job ${jobId} container teardown failed; the job is still tracked and DELETE can be retried`);
    this.name = 'JobCleanupError';
    /** @type {string} */
    this.code = 'daemon.cleanup_failed';
    this.cause = cause;
  }
}

/** Raised when admission control refuses a NEW job because the daemon is at
 *  capacity. A bearer-authed caller must not be able to drive unbounded concurrent
 *  container creation / daemon memory growth, so both a live-job cap and a smaller
 *  in-flight cap gate every new provision. The HTTP layer maps it to 429. */
export class JobCapacityError extends Error {
  /** @param {'live' | 'inflight'} kind @param {number} limit */
  constructor(kind, limit) {
    super(
      kind === 'inflight'
        ? `too many jobs are being created at once (in-flight cap ${limit})`
        : `the daemon is at its live-job capacity (${limit})`,
    );
    this.name = 'JobCapacityError';
    /** @type {string} */
    this.code = kind === 'inflight' ? 'daemon.too_many_inflight' : 'daemon.at_capacity';
  }
}


/** Raised when a failed `createJobContainer` could not clean up after itself.
 *  The job is never registered, so nothing holds a handle on whatever survived —
 *  the error names the resources so an operator (or the reaper, which knows the
 *  deterministic `omadia-job-<id>` names) can remove them. Mapped to 500: this is
 *  a daemon-side failure, not a bad request. */
export class CreateRollbackError extends Error {
  /** @param {string} jobId @param {readonly string[]} resources @param {readonly string[]} failures @param {unknown} cause */
  constructor(jobId, resources, failures, cause) {
    super(
      `job ${jobId} failed to create AND failed to roll back; these may survive: ${resources.join(', ')} (${failures.join('; ')})`,
    );
    this.name = 'CreateRollbackError';
    /** @type {string} */
    this.code = 'daemon.create_rollback_failed';
    /** @type {readonly string[]} */
    this.resources = resources;
    this.cause = cause;
  }
}

/**
 * Strip docker's stream framing from a non-TTY log buffer: each frame is an
 * 8-byte header (stream byte, three pad bytes, 4-byte big-endian payload
 * length) followed by that many payload bytes. A buffer that does not look
 * framed is returned untouched, so a TTY container (or a future docker that
 * stops framing) still yields its text.
 * @param {Buffer} buf @returns {Buffer}
 */
function demuxLogBuffer(buf) {
  /** @type {Buffer[]} */
  const parts = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamByte = buf[offset];
    if (streamByte !== 0 && streamByte !== 1 && streamByte !== 2) return buf; // not framed
    const length = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buf.length) return buf; // truncated/unframed — hand back what we got
    parts.push(buf.subarray(start, end));
    offset = end;
  }
  return offset === buf.length && parts.length > 0 ? Buffer.concat(parts) : buf;
}

/**
 * The repository part of an image reference: strip any `@digest`, then a
 * trailing `:tag` — but only from the LAST path segment, so a registry port
 * (`ghcr.io:5000/org/img`) is not mistaken for a tag.
 * @param {string} ref @returns {string}
 */
function repositoryOf(ref) {
  const noDigest = ref.split('@')[0] ?? ref;
  const slash = noDigest.lastIndexOf('/');
  const lastSegment = noDigest.slice(slash + 1);
  const colon = lastSegment.lastIndexOf(':');
  return colon === -1 ? noDigest : noDigest.slice(0, slash + 1 + colon);
}

/** Absolute lifetime of a job container, renewals notwithstanding. The middleware
 *  renews a lease to say "still working"; it can never say "run forever". */
export const DEFAULT_MAX_JOB_LIFETIME_MS = 6 * 60 * 60 * 1000;

/** Default live-job admission bound (spec §4 hardening). */
export const DEFAULT_MAX_LIVE_JOBS = 8;
/** Default concurrent-provision (in-flight) admission bound — smaller than the
 *  live cap so a burst can't stampede the engine. */
export const DEFAULT_MAX_INFLIGHT_JOBS = 4;

/** @type {Clock} */
const SYSTEM_CLOCK = { now: () => Date.now() };

/**
 * The daemon's live-job registry and the idempotency authority for job create.
 */
export class JobManager {
  /** @type {ContainerEngine} */
  #engine;
  /** @type {PolicyClient} */
  #policyClient;

  /** Optional. Absent ⇒ no egress proxy configured; jobs egress direct (still
   *  clamped by the per-job network). Present ⇒ registration is MANDATORY and a
   *  failure aborts the create: a container that boots without its registration
   *  would be answered 407 on every request, which looks like a network outage. */
  #proxyClient;

  /** @type {(msg: string) => void} */
  #log;
  /** @type {Clock} */
  #clock;
  /** @type {Map<string, JobRecord>} */
  #jobs = new Map();
  /** @type {Map<string, Promise<JobRecord>>} */
  #inflight = new Map();
  /** Job ids a `destroy` cancelled while their create was still in flight. The
   *  in-flight `#provision` reads this after `createJobContainer` resolves and
   *  tears the container down instead of registering it. Lifetime is exactly the
   *  in-flight window (cleared in `create`'s finally). */
  #cancelled = new Set();

  /** Ids whose DELETE is mid-flight: their record still exists but is doomed. */
  #destroying = new Set();

  /** One teardown per id: concurrent DELETEs share the first one's promise. */
  /** @type {Map<string, Promise<boolean>>} */
  #destroyRuns = new Map();
  /** @type {number} Max live jobs (registry size + in-flight) admitted. */
  #maxLiveJobs;
  /** @type {number} Max concurrent provisions admitted. */
  #maxInflight;
  /** @type {number} Absolute container lifetime; renewals cannot exceed it. */
  #maxLifetimeMs;

  /**
   * @param {object} deps
   * @param {ContainerEngine} deps.engine
   * @param {PolicyClient} deps.policyClient
   * @param {Clock} [deps.clock]
   * @param {number} [deps.maxLiveJobs] Live-job admission cap (default 8).
   * @param {number} [deps.maxInflight] In-flight admission cap (default 4).
   * @param {number} [deps.maxJobLifetimeMs] Absolute container lifetime (default 6 h).
   * @param {{ register: Function, unregister: Function }} [deps.proxyClient] Egress-proxy control plane.
   */
  constructor(deps) {
    this.#engine = deps.engine;
    this.#policyClient = deps.policyClient;
    this.#proxyClient = deps.proxyClient;
    this.#log = deps.log ?? (() => {});
    this.#clock = deps.clock ?? SYSTEM_CLOCK;
    this.#maxLiveJobs = deps.maxLiveJobs ?? DEFAULT_MAX_LIVE_JOBS;
    this.#maxInflight = deps.maxInflight ?? DEFAULT_MAX_INFLIGHT_JOBS;
    this.#maxLifetimeMs = deps.maxJobLifetimeMs ?? DEFAULT_MAX_JOB_LIFETIME_MS;
  }

  /**
   * Create (or idempotently re-attach) a job. Returns the record and whether a
   * container was actually created this call. Concurrent creates for the same
   * jobId share one provision, so exactly one container results.
   *
   * @param {string} jobId
   * @param {number} leaseTtlSec
   * @returns {Promise<{ record: JobRecord, created: boolean }>}
   */
  async create(jobId, leaseTtlSec) {
    // A DELETE currently tearing this job down still holds its record (the
    // record is only dropped once cleanup is PROVEN). Handing that record back
    // as a live job would return a container that is about to disappear, so an
    // overlapping create is refused rather than answered with a corpse.
    if (this.#destroying.has(jobId)) throw new JobCancelledError(jobId);

    const existing = this.#jobs.get(jobId);
    if (existing) return { record: existing, created: false };

    const pending = this.#inflight.get(jobId);
    if (pending) return { record: await pending, created: false };

    // Admission control (review medium finding): #jobs and #inflight are otherwise
    // unbounded, so a bearer-authed caller could drive unlimited concurrent
    // container creation and daemon memory growth. A NEW job (neither live nor
    // already provisioning — the idempotent re-attach paths above create nothing)
    // is admitted only under BOTH caps; over either, nothing is created.
    if (this.#jobs.size + this.#inflight.size >= this.#maxLiveJobs) {
      throw new JobCapacityError('live', this.#maxLiveJobs);
    }
    if (this.#inflight.size >= this.#maxInflight) {
      throw new JobCapacityError('inflight', this.#maxInflight);
    }

    const provision = this.#provision(jobId, leaseTtlSec);
    this.#inflight.set(jobId, provision);
    try {
      const record = await provision;
      return { record, created: true };
    } finally {
      this.#inflight.delete(jobId);
      // Clear any cancellation flag so it can never leak into a later create for
      // the same id — its lifetime is exactly this in-flight window.
      this.#cancelled.delete(jobId);
    }
  }

  /**
   * @param {string} jobId
   * @param {number} leaseTtlSec
   * @returns {Promise<JobRecord>}
   */
  async #provision(jobId, leaseTtlSec) {
    // Hex, so the credential survives the URL userinfo round-trip a proxy-aware
    // http client performs, with no encoding ambiguity at either end.
    const proxyToken = this.#proxyClient ? randomBytes(32).toString('hex') : undefined;
    // The daemon fetches the policy ITSELF — never from the caller (S3).
    const policy = await this.#policyClient.fetchJobPolicy(jobId, { proxyToken });
    const leaseExpiresAt = this.#leaseExpiry(leaseTtlSec);
    const hardDeadlineAt = new Date(this.#clock.now() + this.#maxLifetimeMs).toISOString();

    if (this.#proxyClient && proxyToken) {
      // BEFORE the container starts: a runner that boots first races its own first
      // request against this call. The TTL is the job's hard deadline, not its
      // lease — a lease is renewed every ~TTL/3, and hanging egress off that
      // cadence would let one missed refresh silently blackhole a running job.
      // The reaper guarantees no container outlives the hard deadline, so this
      // registration can neither expire under a live job nor outlive a dead one.
      const ttlSec = Math.max(1, Math.ceil(this.#maxLifetimeMs / 1000));
      await this.#proxyClient.register(jobId, {
        allowlist: policy.egressAllowlist,
        proxyToken,
        ttlSec,
      });
    }

    let container;
    try {
      container = await this.#engine.createJobContainer({ jobId, policy, leaseExpiresAt });
    } catch (err) {
      // No container exists, so nothing may keep egress authorisation. Failing to
      // withdraw it is not fatal (it expires at the hard deadline) but it is never silent.
      await this.#withdrawEgress(jobId);
      throw err;
    }
    // A DELETE that raced this create marked the id cancelled WHILE we were
    // provisioning (destroy() saw it in #inflight, not yet in #jobs). Tear the
    // just-created container down instead of registering it, so a
    // delete-before-create-completes never leaks a container nobody will reap.
    if (this.#cancelled.has(jobId)) {
      try {
        await this.#engine.destroyJobContainer(container);
      } catch (err) {
        // The teardown failed, so the container may well still be running. The
        // record is the ONLY handle a later DELETE or the reaper has, and this
        // frame is about to unwind — so register it before rethrowing. Losing
        // the handle here is the same leak `destroy()` refuses to cause; the
        // cancel path must refuse it too.
        this.#jobs.set(jobId, { jobId, container, leaseExpiresAt, hardDeadlineAt });
        throw new JobCleanupError(jobId, err);
      }
      await this.#withdrawEgress(jobId);
      throw new JobCancelledError(jobId);
    }
    /** @type {JobRecord} */
    const record = { jobId, container, leaseExpiresAt, hardDeadlineAt };
    this.#jobs.set(jobId, record);
    return record;
  }

  /**
   * Renew a live job's lease. Returns the updated record, or null if unknown.
   * @param {string} jobId
   * @param {number} leaseTtlSec
   * @returns {JobRecord | null}
   */
  renew(jobId, leaseTtlSec) {
    const record = this.#jobs.get(jobId);
    if (!record) return null;
    // A renewal may extend the lease, but never past the daemon's own deadline.
    // The middleware is trusted to say "still working", not "run forever".
    const requested = Date.parse(this.#leaseExpiry(leaseTtlSec));
    const deadline = Date.parse(record.hardDeadlineAt);
    record.leaseExpiresAt = new Date(Math.min(requested, deadline)).toISOString();
    return record;
  }

  /**
   * Kill + forget a job. Idempotent: destroying an unknown job succeeds with
   * `false` (nothing to do), a known job is torn down via the engine and
   * dropped from the registry.
   *
   * RACE-SAFE against an in-flight create (review medium finding): a DELETE that
   * arrives after `create` recorded the id in `#inflight` but before `#provision`
   * registered it in `#jobs` used to return `false` ('not found'), then the
   * create completed and left a live container for an id the caller believed was
   * deleted — a container nobody would reap. So when the id is not yet in `#jobs`
   * but a create is in flight, we MARK it cancelled; `#provision` then destroys
   * the container it is about to create instead of registering it. This method's
   * checks are synchronous (no await before the decision), so relative to
   * `#provision`'s synchronous check-then-register segment there is no window: the
   * id is either already in `#jobs` (live path) or still only in `#inflight`
   * (cancel path).
   * @param {string} jobId
   * @returns {Promise<boolean>} true if a job was present/in-flight and torn down.
   */
  async destroy(jobId) {
    // Two DELETEs for the same id must not both run a teardown. Without this,
    // the second one can finish AFTER the first succeeded and a fresh create
    // registered a new record — and its unconditional delete would then drop
    // the new job's handle, leaving that container untracked. One teardown per
    // id, and both callers await the same answer.
    const running = this.#destroyRuns.get(jobId);
    if (running) return running;

    const run = this.#destroyOnce(jobId);
    this.#destroyRuns.set(jobId, run);
    try {
      return await run;
    } finally {
      this.#destroyRuns.delete(jobId);
    }
  }

  /** @param {string} jobId @returns {Promise<boolean>} */
  async #destroyOnce(jobId) {
    const record = this.#jobs.get(jobId);
    if (record) {
      this.#destroying.add(jobId);
      // Tear the container down FIRST; only forget the job once cleanup is proven
      // (review medium finding — same class as the W0 backend bug: never destroy
      // the only handle on a live resource before its removal succeeds). If the
      // engine throws, KEEP the record so this DELETE and the future reaper can
      // retry; dropping the handle here would leak a container nothing tracks.
      try {
        await this.#engine.destroyJobContainer(record.container);
      } catch (err) {
        throw new JobCleanupError(jobId, err);
      } finally {
        this.#destroying.delete(jobId);
      }
      // The container is proven gone: withdraw its egress authorisation. Order
      // matters — withdrawing first would strip egress from a container whose
      // teardown then failed and which is still running.
      await this.#withdrawEgress(jobId);
      // Only forget THIS record: a later create may have registered a new one.
      if (this.#jobs.get(jobId) === record) this.#jobs.delete(jobId);
      return true;
    }
    return this.#destroyInflight(jobId);
  }

  /**
   * Remove a job's egress authorisation. Never throws: by the time this runs the
   * container is already gone (or was never created), and the registration expires
   * on its own at the hard deadline. Silence, though, is not on offer.
   * @param {string} jobId
   */
  async #withdrawEgress(jobId) {
    if (!this.#proxyClient) return;
    try {
      await this.#proxyClient.unregister(jobId);
    } catch (err) {
      this.#log(
        `[dev-runner] job ${jobId}: could not withdraw egress authorisation ` +
          `(${err instanceof Error ? err.message : String(err)}); it expires at the job's hard deadline`,
      );
    }
  }

  /** @param {string} jobId @returns {Promise<boolean>} */
  async #destroyInflight(jobId) {
    // No live job yet — but a create may be mid-provision. Mark it cancelled so
    // #provision reaps the container it is about to create, then WAIT for that
    // create to settle before answering. Returning success the moment the flag
    // is set would tell the DELETE caller the job is gone while the cancel
    // teardown might still fail and leave the container tracked and alive.
    const pending = this.#inflight.get(jobId);
    if (pending) {
      this.#cancelled.add(jobId);
      try {
        await pending;
      } catch (err) {
        // JobCancelledError is the expected outcome: the create aborted and its
        // container was torn down. Anything else — notably JobCleanupError —
        // means the container survived and is still tracked, so the DELETE has
        // NOT succeeded and the caller must retry.
        if (err instanceof JobCancelledError) return true;
        throw err;
      }
      // The create won the race and registered a live job; tear that down.
      // Call the inner path: `destroy` would find this very run in #destroyRuns.
      return this.#destroyOnce(jobId);
    }
    return false;
  }

  /**
   * @param {string} jobId
   * @returns {JobRecord | null}
   */
  get(jobId) {
    return this.#jobs.get(jobId) ?? null;
  }

  /** @returns {JobRecord[]} All live jobs — the middleware `reap()` join source. */
  list() {
    return [...this.#jobs.values()];
  }

  /** @returns {number} Count of live jobs. */
  size() {
    return this.#jobs.size;
  }

  /**
   * Re-adopt a container the reaper discovered on the engine at boot, so a daemon
   * restart does not orphan a live job (spec §7: "State rebuilt from container
   * labels on boot"). Idempotent and NON-clobbering: if the id is already live,
   * or a create/destroy for it is in flight, the existing authority wins and this
   * is a no-op — a rebuild that raced a fresh create must never overwrite it.
   * @param {string} jobId
   * @param {JobContainer} container
   * @param {string} leaseExpiresAt
   * @param {number} [createdAtMs] The container's real creation time (docker `Created`).
   * @returns {JobRecord | null} The adopted record, or null if a live op owns the id.
   */
  adopt(jobId, container, leaseExpiresAt, createdAtMs) {
    const existing = this.#jobs.get(jobId);
    if (existing) return existing;
    // A create or destroy already owns this id; its handle is authoritative.
    if (this.#inflight.has(jobId) || this.#destroying.has(jobId)) return null;
    // The deadline is measured from the container's REAL birth, not from this
    // adoption. Otherwise every daemon restart hands the job a fresh lifetime,
    // and a middleware that can restart the daemon has an immortal container.
    const bornAt = typeof createdAtMs === 'number' ? createdAtMs : this.#clock.now();
    /** @type {JobRecord} */
    const record = {
      jobId,
      container,
      leaseExpiresAt,
      hardDeadlineAt: new Date(bornAt + this.#maxLifetimeMs).toISOString(),
    };
    this.#jobs.set(jobId, record);
    return record;
  }

  /**
   * True if this id is live, being provisioned, or being torn down. The reaper's
   * "not an orphan" guard: a mid-create job's network/volume exist before its
   * record lands in `#jobs`, so an orphan sweep that keyed only on `list()` would
   * reap a healthy job's resources out from under it (hard-won lesson (a)).
   * @param {string} jobId
   * @returns {boolean}
   */
  tracks(jobId) {
    return this.#jobs.has(jobId) || this.#inflight.has(jobId) || this.#destroying.has(jobId);
  }

  /**
   * @param {number} leaseTtlSec
   * @returns {string} ISO-8601 lease expiry.
   */
  #leaseExpiry(leaseTtlSec) {
    return new Date(this.#clock.now() + leaseTtlSec * 1000).toISOString();
  }
}

/**
 * Build dockerode client options from the standard Docker env (spec §8): TLS to
 * dind is MANDATORY over a `tcp://` endpoint — no host docker socket, no 2375
 * plaintext fallback, no ssh tunnel.
 *
 * `DOCKER_HOST=tcp://dev-dind:2376`, `DOCKER_TLS_VERIFY=1`, and `DOCKER_CERT_PATH`
 * pointing at `{ca,cert,key}.pem`. The scheme is enforced (round-3 finding): a
 * `unix://` host socket, an `http(s)://`, an `ssh://` tunnel, or a Windows
 * `npipe://` would each defeat the "tcp+TLS only, never a host socket" contract,
 * so any non-`tcp:` scheme is a FATAL boot error naming the offending value.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Docker.DockerOptions}
 */
export function dockerOptionsFromEnv(env) {
  const host = env.DOCKER_HOST;
  if (!host) {
    throw new Error('DOCKER_HOST is not set — the daemon requires a dind engine over tcp+TLS');
  }
  let parsed;
  try {
    parsed = new URL(host);
  } catch {
    throw new Error(`DOCKER_HOST is not a parseable URL: ${host}`);
  }
  // Scheme clamp: ONLY tcp:// is a dind-over-TLS endpoint. unix/http/https/ssh/
  // npipe are all refused — a host socket next to the middleware would be RCE.
  if (parsed.protocol !== 'tcp:') {
    throw new Error(
      `DOCKER_HOST must use the tcp:// scheme (TLS to dind); refusing ${JSON.stringify(host)} ` +
        `— unix/http/https/ssh/npipe sockets are not allowed`,
    );
  }
  if (!parsed.hostname) {
    throw new Error(`DOCKER_HOST has no host: ${host}`);
  }
  if (!parsed.port) {
    throw new Error(`DOCKER_HOST must include an explicit port (e.g. tcp://dev-dind:2376): ${host}`);
  }
  const tls = env.DOCKER_TLS_VERIFY === '1' || env.DOCKER_TLS_VERIFY === 'true';
  if (!tls) {
    throw new Error('daemon requires TLS to dind: set DOCKER_TLS_VERIFY=1');
  }
  const certPath = env.DOCKER_CERT_PATH;
  if (!certPath) {
    throw new Error('daemon requires DOCKER_CERT_PATH pointing at {ca,cert,key}.pem');
  }
  let ca;
  let cert;
  let key;
  try {
    ca = readFileSync(join(certPath, 'ca.pem'));
    cert = readFileSync(join(certPath, 'cert.pem'));
    key = readFileSync(join(certPath, 'key.pem'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `DOCKER_CERT_PATH is not readable — need ca.pem, cert.pem, key.pem in ${JSON.stringify(certPath)}: ${reason}`,
    );
  }
  return {
    host: parsed.hostname,
    port: Number(parsed.port),
    protocol: 'https',
    ca,
    cert,
    key,
  };
}

/** True when a dockerode error carries the given HTTP status (404 = gone, 304 =
 *  not-modified/already-stopped, 409 = conflict). Errors from dockerode are plain
 *  objects with a `statusCode`; anything else (a network error) is not a status.
 * @param {unknown} err @param {number} code @returns {boolean} */
function hasStatus(err, code) {
  return typeof err === 'object' && err !== null && 'statusCode' in err && err.statusCode === code;
}

/** @param {unknown} err @returns {boolean} */
function isNotFound(err) {
  return hasStatus(err, 404);
}

/** @param {unknown} err @returns {string} */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** True when `ref` is already present in the engine — a LOCAL inspect, no registry
 *  contact. A 404 means "not present, must pull"; any other error is a real engine
 *  fault and PROPAGATES. An ambiguous failure is never coerced into "present" (which
 *  would skip a genuinely-needed pull) nor "absent" (which would force a doomed
 *  registry round-trip and mask the real fault).
 * @param {Docker} docker @param {string} ref @returns {Promise<boolean>} */
async function imageIsPresent(docker, ref) {
  try {
    await docker.getImage(ref).inspect();
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Ensure an image ref is available to create a container from, honouring the pull
 *  policy. A pull is a progress STREAM — resolving the `pull` call is not resolving
 *  the pull, so we drain `followProgress`. Digest-pinned refs resolve to exactly
 *  that content; tags resolve at the registry.
 *
 *  `pullPolicy`:
 *    - `always` (default — the prod posture): pull unconditionally, so every
 *      provision re-fetches the pinned digest the boot-time cosign step vetted.
 *    - `if-not-present`: skip the pull — and the registry contact it requires —
 *      when the ref is ALREADY cached in the engine. This is for local dev, where
 *      the image was `docker load`ed into dind and the default-deny egress proxy
 *      answers a registry pull with 407. It ONLY changes whether a PRESENT image is
 *      re-pulled; it does NOT touch the image allowlist or the digest requirement
 *      (both enforced against the job policy in policyClient, long before this runs),
 *      so a job naming an unlisted image is still refused whether or not it is cached.
 * @param {Docker} docker @param {string} ref
 * @param {'always' | 'if-not-present'} [pullPolicy]
 * @returns {Promise<void>} */
async function ensureImage(docker, ref, pullPolicy = 'always') {
  if (pullPolicy === 'if-not-present' && (await imageIsPresent(docker, ref))) {
    return;
  }
  await new Promise((resolve, reject) => {
    docker.pull(
      ref,
      /** @param {Error | null} err @param {NodeJS.ReadableStream} [stream] */ (err, stream) => {
        if (err) return reject(err);
        if (!stream) return reject(new Error(`docker pull returned no stream for ${ref}`));
        docker.modem.followProgress(stream, (doneErr) => (doneErr ? reject(doneErr) : resolve()));
      },
    );
  });
}

/** Remove a container after a graceful SIGTERM/10s/SIGKILL stop, then VERIFY it is
 *  gone (lesson (c): a remove call returning is not proof of removal). A 404 at any
 *  step means already-gone (idempotent). Any surviving container or hard error is
 *  pushed to `errors` so the caller keeps the handle and can retry.
 * @param {Docker} docker @param {string} id @param {string[]} errors */
async function removeContainer(docker, id, errors) {
  if (!id) return;
  const container = docker.getContainer(id);
  try {
    // SIGTERM, 10s grace; docker escalates to SIGKILL at the deadline.
    await container.stop({ t: 10 });
  } catch {
    // Every stop failure is survivable: 304 (already stopped), 404 (already
    // gone), or anything else. The force remove below is the guarantee and the
    // post-remove inspect is the proof — a graceful stop is only a courtesy.
  }
  try {
    await container.remove({ force: true, v: true });
  } catch (err) {
    if (!isNotFound(err)) errors.push(`container ${id} remove failed: ${errMessage(err)}`);
  }
  try {
    await container.inspect();
    errors.push(`container ${id} still present after remove`);
  } catch (err) {
    if (!isNotFound(err)) errors.push(`container ${id} removal unverifiable: ${errMessage(err)}`);
  }
}

/** Remove the per-job network and verify (lesson (c)). 404 = already gone.
 * @param {Docker} docker @param {string} id @param {string[]} errors */
async function removeNetwork(docker, id, errors) {
  if (!id) return;
  const network = docker.getNetwork(id);
  try {
    await network.remove();
  } catch (err) {
    if (!isNotFound(err)) errors.push(`network ${id} remove failed: ${errMessage(err)}`);
  }
  try {
    await network.inspect();
    errors.push(`network ${id} still present after remove`);
  } catch (err) {
    if (!isNotFound(err)) errors.push(`network ${id} removal unverifiable: ${errMessage(err)}`);
  }
}

/** Remove the per-job workspace volume and verify (lesson (c)). 404 = already gone.
 * @param {Docker} docker @param {string} name @param {string[]} errors */
async function removeVolume(docker, name, errors) {
  if (!name) return;
  const volume = docker.getVolume(name);
  try {
    await volume.remove({ force: true });
  } catch (err) {
    if (!isNotFound(err)) errors.push(`volume ${name} remove failed: ${errMessage(err)}`);
  }
  try {
    await volume.inspect();
    errors.push(`volume ${name} still present after remove`);
  } catch (err) {
    if (!isNotFound(err)) errors.push(`volume ${name} removal unverifiable: ${errMessage(err)}`);
  }
}

/** Resolve the image pull policy from the daemon env. `always` (the default, and
 *  the value for prod where the runner image lives on GHCR) re-pulls every image on
 *  every provision so the boot-time digest-pin + cosign vetting is enforced each
 *  time. `if-not-present` skips a re-pull when the image is already cached in the
 *  engine — for local dev where the image was `docker load`ed into dind and the
 *  default-deny egress proxy answers a registry pull with 407. An unknown value is
 *  a boot-time error rather than a silent fallback: a misconfiguration must be loud,
 *  never quietly weaken (or quietly harden) the pull behaviour.
 * @param {NodeJS.ProcessEnv} env @returns {'always' | 'if-not-present'} */
export function resolvePullPolicy(env) {
  const raw = (env.DEV_RUNNER_PULL_POLICY ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'always') return 'always';
  if (raw === 'if-not-present') return 'if-not-present';
  throw new Error(
    `DEV_RUNNER_PULL_POLICY must be 'always' or 'if-not-present' (got ${JSON.stringify(env.DEV_RUNNER_PULL_POLICY)})`,
  );
}

/**
 * A real dockerode-backed engine implementing the full §4 container lifecycle
 * behind the `ContainerEngine` seam. `createJobContainer` builds the create-options
 * via the PURE `buildContainerCreateOptions` and hands THAT EXACT object to
 * dockerode (lesson (b) — the validated object is the launched object), after
 * creating the per-job bridge network and workspace volume; on any failure it
 * rolls the partial resources back so a failed create leaks nothing.
 *
 * @param {object} [opts]
 * @param {Docker} [opts.docker] Injected client (else built from env).
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {ContainerEngine}
 */
export function createDockerEngine(opts = {}) {
  const env = opts.env ?? process.env;
  const docker = opts.docker ?? new Docker(dockerOptionsFromEnv(env));
  const limits = resolveClampLimits(env);
  const createdBy = env.DEV_RUNNER_CREATED_BY?.trim() || 'omadia-middleware';
  // W5 opt-in DinD (spec §8): daemon-owned sidecar image + nested-store disk cap.
  const dindImage = resolveDindImage(env);
  const dindDiskGb = resolveDindDiskGb(env);
  // Resolved once at engine construction: the same policy governs the per-job image
  // pull, the DinD sidecar image pull, and the warm loop, so all three agree.
  const pullPolicy = resolvePullPolicy(env);

  return {
    async ping() {
      try {
        await docker.ping();
        const version = await docker.version();
        return { reachable: true, apiVersion: String(version.ApiVersion ?? '') };
      } catch {
        return { reachable: false, apiVersion: '' };
      }
    },

    async createJobContainer({ jobId, policy, leaseExpiresAt }) {
      const networkName = jobNetworkName(jobId);
      const volumeName = jobVolumeName(jobId);
      const dockerInJob = policy.dockerInJob === true;
      // Build (and thereby VALIDATE) the create-options FIRST: a forbidden spec
      // (a floating-tag image) throws SpecRejectedError here, before any docker
      // resource is created — so a rejected job leaks nothing.
      const createOptions = buildContainerCreateOptions({
        jobId,
        policy,
        leaseExpiresAt,
        networkName,
        volumeName,
        createdBy,
        limits,
        dockerInJob,
      });
      const imageDigest = imageDigestOf(policy.image);
      if (imageDigest === undefined) {
        // Unreachable: buildContainerCreateOptions already rejected a tag-only image.
        throw new SpecRejectedError('image_not_digest_pinned', 'the job image resolved to no digest');
      }
      // Resolve the image BY DIGEST (never a floating tag) so the container is
      // created from exactly the vetted content.
      await ensureImage(docker, policy.image, pullPolicy);

      const labels = {
        [JOB_ID_LABEL]: jobId,
        [CREATED_BY_LABEL]: createdBy,
      };
      /** @type {import('dockerode').Network | undefined} */
      let network;
      let volumeCreated = false;
      // DinD sidecar state, tracked for rollback (spec §8).
      let dindImageVolCreated = false;
      let dindCertsVolCreated = false;
      /** @type {import('dockerode').Container | undefined} */
      let sidecar;
      /** @type {import('dockerode').Container | undefined} */
      let container;
      try {
        // Per-job bridge (NOT --internal: the job needs the NAT hop to the egress
        // proxy) and per-job workspace volume, both UUID-named for the reaper.
        network = await docker.createNetwork({ Name: networkName, Driver: 'bridge', Internal: false, Labels: labels });
        await docker.createVolume({ Name: volumeName, Labels: labels });
        volumeCreated = true;

        if (dockerInJob) {
          // The sidecar goes up FIRST, on the JOB's isolated network, so the job
          // container can reach `tcp://dind:2376` the instant it boots (spec §8).
          // Its nested-image store is a dedicated SIZE-CAPPED volume and its TLS
          // material lands on the shared certs volume the job mounts read-only.
          // Nested-container egress has no route but the job's egress proxy.
          await docker.createVolume(buildDindImageStoreVolumeOptions({ jobId, createdBy, diskGb: dindDiskGb }));
          dindImageVolCreated = true;
          await docker.createVolume(buildDindCertsVolumeOptions({ jobId, createdBy }));
          dindCertsVolCreated = true;
          await ensureImage(docker, dindImage, pullPolicy);
          sidecar = await docker.createContainer(
            buildDindCreateOptions({ jobId, networkName, createdBy, leaseExpiresAt, limits, image: dindImage }),
          );
          await sidecar.start();
        }

        // Lesson (b): the object validated above is the object launched now.
        container = await docker.createContainer(createOptions);
        await container.start();
        return { jobId, containerId: container.id, networkId: network.id, volumeName, imageDigest, dockerInJob };
      } catch (err) {
        // Roll back whatever this create managed to make, so a partial failure
        // never strands a network/volume/container/sidecar nobody tracks.
        /** @type {string[]} */
        const rollback = [];
        if (container) await removeContainer(docker, container.id, rollback);
        if (sidecar) await removeContainer(docker, sidecar.id, rollback);
        if (network) await removeNetwork(docker, network.id, rollback);
        if (volumeCreated) await removeVolume(docker, volumeName, rollback);
        if (dindImageVolCreated) await removeVolume(docker, dindVolumeName(jobId), rollback);
        if (dindCertsVolCreated) await removeVolume(docker, dindCertsVolumeName(jobId), rollback);
        if (rollback.length > 0) {
          // The rollback itself failed. Nothing will hold a handle on these —
          // the job was never registered — so the ONLY way they get cleaned up
          // is if the failure is loud and names them. Swallowing it here is the
          // same lost-handle leak `destroy()` refuses to cause. The names are
          // deterministic (`omadia-job-<id>`), so an operator or the reaper can
          // find exactly what survived.
          const named = dockerInJob
            ? [networkName, volumeName, dindContainerName(jobId), dindVolumeName(jobId), dindCertsVolumeName(jobId)]
            : [networkName, volumeName];
          throw new CreateRollbackError(jobId, named, rollback, err);
        }
        throw err;
      }
    },

    async destroyJobContainer(container) {
      // Idempotent full teardown: container (graceful stop → remove), per-job
      // network, per-job volume — each verified gone. A second call on a
      // partially-removed job finds 404s and succeeds; any resource that will
      // NOT remove surfaces as a throw so the caller keeps the handle to retry.
      /** @type {string[]} */
      const errors = [];
      await removeContainer(docker, container.containerId, errors);
      // The DinD sidecar container + its two volumes are torn down WITH the job
      // (spec §8), by DETERMINISTIC name so the reaper's label-only rebuild/orphan
      // paths clean them too. Gated on the handle's `dockerInJob` flag so a plain
      // job's teardown is byte-identical to before W5 (never touches a sidecar it
      // never had — the existing teardown tests assert exactly that).
      if (container.dockerInJob && container.jobId) {
        await removeContainer(docker, dindContainerName(container.jobId), errors);
      }
      await removeNetwork(docker, container.networkId, errors);
      await removeVolume(docker, container.volumeName, errors);
      if (container.dockerInJob && container.jobId) {
        await removeVolume(docker, dindVolumeName(container.jobId), errors);
        await removeVolume(docker, dindCertsVolumeName(container.jobId), errors);
      }
      if (errors.length > 0) {
        throw new Error(`destroyJobContainer failed to fully remove job resources: ${errors.join('; ')}`);
      }
    },

    async streamLogs(container, { follow }) {
      const handle = docker.getContainer(container.containerId);
      // Branch on the literal so the SDK's overloads resolve: `follow:true` yields
      // a live stream; `follow:false` a single Buffer, which we wrap as ONE chunk
      // so the reader gets raw bytes, not per-byte object-mode integers.
      if (follow) {
        const stream = /** @type {Readable} */ (
          /** @type {unknown} */ (await handle.logs({ follow: true, stdout: true, stderr: true }))
        );
        // The clamp creates non-TTY containers, so docker frames every chunk with
        // an 8-byte stream header. Demux it here: the seam promises "combined
        // stdout/stderr", and an operator tailing a job must not have to parse
        // docker's wire format out of their log lines.
        const out = new PassThrough();
        docker.modem.demuxStream(stream, out, out);
        stream.on('end', () => out.end());
        stream.on('error', (err) => out.destroy(err));
        // Destroying the demuxed stream must release the upstream docker socket,
        // which is what the daemon's follow-slot teardown relies on.
        out.on('close', () => {
          if (typeof stream.destroy === 'function') stream.destroy();
        });
        return out;
      }
      const buffer = await handle.logs({ follow: false, stdout: true, stderr: true });
      // The one-shot path is framed exactly like the follow path — same non-TTY
      // container, same 8-byte headers. Demuxing only one of them would leave
      // `GET /logs` (no ?follow) handing docker's wire format to the operator.
      return Readable.from([demuxLogBuffer(Buffer.from(buffer))]);
    },

    async warmImages(refs) {
      /** @type {string[]} */
      const digests = [];
      for (const ref of refs) {
        await ensureImage(docker, ref, pullPolicy);
        const info = await docker.getImage(ref).inspect();
        const repoDigests = Array.isArray(info.RepoDigests) ? info.RepoDigests : [];
        // An image pulled under several names carries one RepoDigest per
        // repository, and they are NOT interchangeable — taking [0] can hand
        // back a digest that belongs to a different registry than the ref we
        // were asked to warm. Match on the repository we actually pulled.
        const repository = repositoryOf(ref);
        const match = repoDigests.find((rd) => typeof rd === 'string' && rd.startsWith(`${repository}@`));
        const resolved =
          typeof match === 'string'
            ? match.slice(match.indexOf('@') + 1)
            : (imageDigestOf(ref) ?? String(info.Id ?? ''));
        digests.push(resolved);
      }
      return digests;
    },

    async listManagedResources() {
      // One label selects every resource this daemon authored; the createdBy
      // check below narrows to THIS deployment so a shared engine's other jobs
      // are never in scope. Filters ride as a JSON string (dockerode accepts it
      // for all three list calls) to sidestep per-endpoint filter-typing drift.
      const filters = JSON.stringify({ label: [JOB_ID_LABEL] });
      const [rawContainers, rawNetworks, rawVolumesResult] = await Promise.all([
        docker.listContainers({ all: true, filters }),
        docker.listNetworks({ filters }),
        docker.listVolumes({ filters }),
      ]);

      /** @type {ManagedContainer[]} */
      const containers = [];
      for (const c of rawContainers ?? []) {
        const jobLabels = c.Labels;
        // Only resources this deployment created: a foreign createdBy is skipped
        // so we never tear down another daemon's job on the same engine.
        if (!jobLabels || jobLabels[CREATED_BY_LABEL] !== createdBy) continue;
        const jobId = jobLabels[JOB_ID_LABEL];
        if (!jobId) continue;
        // The DinD sidecar carries the same jobId label; skip it so the reaper
        // never adopts it as a second job container (which would clobber the real
        // container's handle). It is torn down WITH the job by deterministic name.
        if (jobLabels[DEV_ROLE_LABEL] === ROLE_DIND) continue;
        containers.push({
          jobId,
          containerId: String(c.Id ?? ''),
          leaseExpiresAt: jobLabels[LEASE_EXPIRES_LABEL] ?? '',
          imageDigest: imageDigestOf(String(c.Image ?? '')) ?? '',
          running: c.State === 'running',
          dockerInJob: jobLabels[DEV_DOCKER_IN_JOB_LABEL] === 'true',
          // docker reports `Created` in unix seconds.
          createdAtMs: typeof c.Created === 'number' ? c.Created * 1000 : Date.now(),
        });
      }

      /** @type {ManagedResource[]} */
      const networks = [];
      for (const n of rawNetworks ?? []) {
        const jobLabels = n.Labels;
        if (!jobLabels || jobLabels[CREATED_BY_LABEL] !== createdBy) continue;
        const jobId = jobLabels[JOB_ID_LABEL];
        if (!jobId) continue;
        networks.push({ jobId, id: String(n.Id ?? n.Name ?? '') });
      }

      /** @type {ManagedResource[]} */
      const volumes = [];
      for (const v of rawVolumesResult?.Volumes ?? []) {
        const jobLabels = v.Labels;
        if (!jobLabels || jobLabels[CREATED_BY_LABEL] !== createdBy) continue;
        const jobId = jobLabels[JOB_ID_LABEL];
        if (!jobId) continue;
        volumes.push({ jobId, id: String(v.Name ?? '') });
      }

      return { containers, networks, volumes };
    },
  };
}
