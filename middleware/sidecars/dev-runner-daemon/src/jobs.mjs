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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Docker from 'dockerode';

/**
 * @typedef {import('./policyClient.mjs').DerivedJobPolicy} DerivedJobPolicy
 * @typedef {import('./policyClient.mjs').PolicyClient} PolicyClient
 */

/**
 * A created job container, as the engine reports it back.
 * @typedef {object} JobContainer
 * @property {string} containerId
 * @property {string} networkId
 * @property {string} volumeName
 * @property {string} imageDigest
 */

/**
 * dind reachability + engine version, for `/v1/health`.
 * @typedef {object} EnginePing
 * @property {boolean} reachable
 * @property {string} apiVersion
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
 */

/**
 * One live job the daemon is tracking.
 * @typedef {object} JobRecord
 * @property {string} jobId
 * @property {JobContainer} container
 * @property {string} leaseExpiresAt
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

  /**
   * @param {object} deps
   * @param {ContainerEngine} deps.engine
   * @param {PolicyClient} deps.policyClient
   * @param {Clock} [deps.clock]
   */
  constructor(deps) {
    this.#engine = deps.engine;
    this.#policyClient = deps.policyClient;
    this.#clock = deps.clock ?? SYSTEM_CLOCK;
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
    const existing = this.#jobs.get(jobId);
    if (existing) return { record: existing, created: false };

    const pending = this.#inflight.get(jobId);
    if (pending) return { record: await pending, created: false };

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
    // The daemon fetches the policy ITSELF — never from the caller (S3).
    const policy = await this.#policyClient.fetchJobPolicy(jobId);
    const leaseExpiresAt = this.#leaseExpiry(leaseTtlSec);
    const container = await this.#engine.createJobContainer({ jobId, policy, leaseExpiresAt });
    // A DELETE that raced this create marked the id cancelled WHILE we were
    // provisioning (destroy() saw it in #inflight, not yet in #jobs). Tear the
    // just-created container down instead of registering it, so a
    // delete-before-create-completes never leaks a container nobody will reap.
    if (this.#cancelled.has(jobId)) {
      await this.#engine.destroyJobContainer(container);
      throw new JobCancelledError(jobId);
    }
    /** @type {JobRecord} */
    const record = { jobId, container, leaseExpiresAt };
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
    record.leaseExpiresAt = this.#leaseExpiry(leaseTtlSec);
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
    const record = this.#jobs.get(jobId);
    if (record) {
      // Drop from the registry first so a concurrent create sees it gone and a
      // re-create provisions a fresh container rather than re-attaching a corpse.
      this.#jobs.delete(jobId);
      await this.#engine.destroyJobContainer(record.container);
      return true;
    }
    // No live job yet — but a create may be mid-provision. Mark it cancelled so
    // #provision reaps the container it is about to create.
    if (this.#inflight.has(jobId)) {
      this.#cancelled.add(jobId);
      return true;
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

/**
 * A real dockerode-backed engine. `ping` (used by `/v1/health`) is implemented
 * now; the mutating lifecycle methods are the seam the clamp/warmer units fill,
 * so they throw `EngineNotImplementedError` until then.
 *
 * @param {object} [opts]
 * @param {Docker} [opts.docker] Injected client (else built from env).
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {ContainerEngine}
 */
export function createDockerEngine(opts = {}) {
  const docker = opts.docker ?? new Docker(dockerOptionsFromEnv(opts.env ?? process.env));
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
    async createJobContainer() {
      throw new EngineNotImplementedError('createJobContainer');
    },
    async destroyJobContainer() {
      throw new EngineNotImplementedError('destroyJobContainer');
    },
    async streamLogs() {
      throw new EngineNotImplementedError('streamLogs');
    },
    async warmImages() {
      throw new EngineNotImplementedError('warmImages');
    },
  };
}
