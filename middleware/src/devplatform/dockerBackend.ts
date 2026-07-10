/**
 * Epic #470 W1 — `DockerBackend`: the middleware's client for the runner daemon
 * (spec §4/§5). It supersedes the W0 `LocalProcessBackend` as the shipping
 * execution path; the local backend is demoted to a `DEV_PLATFORM_UNSAFE_LOCAL`
 * escape hatch (see `wireDevPlatform.buildBackends`).
 *
 * The whole point of this backend is that IT IS THE CALLER, and a caller never
 * dictates policy. `provision()` therefore posts EXACTLY `{ protocol, jobId,
 * leaseTtlSec }` to the daemon and nothing else — no env, no image, no egress
 * allowlist, no limits. The daemon fetches the job's policy itself from the
 * middleware's job-policy endpoint and derives it from the `dev_repos` row
 * (spec §4, review finding S3: "a clamp that trusts caller-supplied policy is
 * not a clamp"). The wire schema (`daemonProtocol.ts`) enforces the exact shape
 * at both ends; a body smuggling extra keys is rejected before any handler runs.
 *
 * Contract mirror (LocalProcessBackend): a teardown that does NOT prove the
 * resource is gone must surface and RETAIN the handle. `terminate()` treats a
 * daemon 404 as success (the container is already gone, idempotent) but a `502
 * daemon.cleanup_failed` is re-thrown with the handle kept so the caller retries
 * — never dropping the only handle on a live, possibly credential-bearing
 * container. `reap()` returns the handles the middleware still tracks that the
 * daemon no longer knows about, so the worker finalizes those jobs `stalled`.
 *
 * Every daemon call is bearer-authenticated, bounded by one timeout that spans
 * headers AND the body read, refuses redirects, and caps the response body — the
 * daemon lives on an internal network, but the client is not the weak end
 * (spec §5, mirroring `sidecars/dev-runner-daemon/src/policyClient.mjs`).
 */

import {
  CreateJobResponseSchema,
  DAEMON_PROTOCOL_VERSION,
  LeaseResponseSchema,
  ListJobsResponseSchema,
  type JobSummary,
} from './daemonProtocol.js';
import { RunnerBackendError, type RunnerBackend, type RunnerHandle } from './runnerBackend.js';
import type { DevJobProvisionInput } from './types.js';

/** Spec §8: default lease TTL. Bounded to the daemon's [30, 3600] window. */
export const DEFAULT_LEASE_TTL_SEC = 180;
/** Spec §5 timeouts. `provision` allows a cold registry pull; everything else is tight. */
const DEFAULT_PROVISION_TIMEOUT_MS = 120_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
/** Daemon control-plane responses are small JSON; a body past this is hostile. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** `provision` re-tries a create ONLY after confirming the job is absent (never a
 *  blind re-create). Two attempts with a widening backoff (spec §5). */
const DEFAULT_PROVISION_RETRY_BACKOFF_MS = [2_000, 8_000] as const;

/**
 * The docker handle persisted to `dev_jobs.runner_handle`. `id` is the jobId so
 * `DevJobStore.findActiveByHandleId` (matches on `runner_handle->>'id'`) joins a
 * reaped handle back to its row without depending on heartbeat freshness. The
 * daemon-returned resource ids ride alongside for `terminate`, debugging, and the
 * admin surface.
 */
export interface DockerRunnerHandle extends RunnerHandle {
  backend: 'docker';
  /** = jobId — the store/reap join key. */
  id: string;
  jobId: string;
  containerId: string;
  networkId: string;
  volumeName: string;
  imageDigest: string;
  leaseExpiresAt: string;
  startedAt: string;
}

/**
 * A typed daemon failure. Extends `RunnerBackendError` so `.code` survives into
 * `dev_jobs.error`/logs, and adds the two policy bits the worker's callers act on:
 *   - `retryable` — a 429 at-capacity: the create should be retried later, NOT
 *     recorded as a job failure (spec §5 error taxonomy).
 *   - `keepHandle` — a 502 `daemon.cleanup_failed`: the teardown did not prove
 *     the container gone, so the caller MUST keep the handle and retry (mirrors
 *     the local backend's `local_terminate_incomplete`).
 */
export class DockerBackendError extends RunnerBackendError {
  readonly retryable: boolean;
  readonly keepHandle: boolean;
  readonly httpStatus: number | undefined;

  constructor(
    code: string,
    message: string,
    opts?: { retryable?: boolean; keepHandle?: boolean; httpStatus?: number },
  ) {
    super(code, message);
    this.name = 'DockerBackendError';
    this.retryable = opts?.retryable ?? false;
    this.keepHandle = opts?.keepHandle ?? false;
    this.httpStatus = opts?.httpStatus;
  }
}

export interface DockerBackendDeps {
  /** `DEV_RUNNER_DAEMON_URL` — the daemon's control-plane origin (e.g.
   *  `http://dev-runner-daemon:7411`). */
  readonly daemonUrl: string;
  /** `DEV_RUNNER_DAEMON_TOKEN` — the shared bearer every call carries. */
  readonly daemonToken: string;
  /** Lease TTL requested at provision + renewed at ~TTL/3 (spec §7). Default 180. */
  readonly leaseTtlSec?: number;
  /** Test seam. Default global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly log?: (msg: string) => void;
  readonly provisionTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  /** Retry backoff steps for the confirm-absent create retry. Tests pass `[0,0]`. */
  readonly provisionRetryBackoffMs?: readonly number[];
  /** Test seam — the sleeper the confirm-absent retry uses. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
  /** Manage the lease-renewal interval externally (tests drive `renewLeases()`
   *  directly). When false (default) the backend runs its own unref'd timer. */
  readonly autoRenew?: boolean;
  /** Test seam — override the computed ~TTL/3 renewal interval so a test does not
   *  wait the real (≥10 s) cadence. Production leaves it unset. */
  readonly renewIntervalMs?: number;
}

/** Minimal shape parsed off a non-2xx daemon body: its `{ code }` if present. */
interface DaemonErrorBody {
  code?: unknown;
  message?: unknown;
}

export class DockerBackend implements RunnerBackend {
  readonly kind = 'docker' as const;

  private readonly daemonBase: string;
  private readonly token: string;
  private readonly leaseTtlSec: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly provisionTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly backoffMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly autoRenew: boolean;
  /** The renewal cadence — spec §7's "roughly TTL/3". */
  private readonly renewIntervalMs: number;

  /** Live jobs this middleware tracks, keyed by jobId. The reap join source AND
   *  the lease-loop's work set: a job leaves it only when terminated or reaped. */
  private readonly live = new Map<string, DockerRunnerHandle>();
  private renewTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: DockerBackendDeps) {
    if (!deps.daemonUrl || deps.daemonUrl.trim() === '') {
      throw new DockerBackendError(
        'devplatform.docker_daemon_url_required',
        'DockerBackend requires DEV_RUNNER_DAEMON_URL',
      );
    }
    if (!deps.daemonToken || deps.daemonToken.trim() === '') {
      throw new DockerBackendError(
        'devplatform.docker_daemon_token_required',
        'DockerBackend requires DEV_RUNNER_DAEMON_TOKEN (the daemon is bearer-authenticated)',
      );
    }
    this.daemonBase = deps.daemonUrl.replace(/\/+$/, '');
    this.token = deps.daemonToken;
    this.leaseTtlSec = clampLeaseTtl(deps.leaseTtlSec ?? DEFAULT_LEASE_TTL_SEC);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((msg) => console.warn(msg));
    this.provisionTimeoutMs = deps.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
    this.callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.backoffMs = deps.provisionRetryBackoffMs ?? DEFAULT_PROVISION_RETRY_BACKOFF_MS;
    this.sleep = deps.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.autoRenew = deps.autoRenew ?? true;
    // TTL/3, floored at 1s so a tiny test TTL never yields a 0ms interval. A test
    // seam can override it so the loop test does not wait the real cadence.
    this.renewIntervalMs =
      deps.renewIntervalMs ?? Math.max(1_000, Math.round((this.leaseTtlSec * 1_000) / 3));
  }

  // -------------------------------------------------------------------------
  // provision
  // -------------------------------------------------------------------------

  /**
   * Provision a job by naming it to the daemon — `POST /v1/jobs` with EXACTLY
   * `{ protocol, jobId, leaseTtlSec }`. The daemon derives env/image/egress
   * itself; this caller supplies nothing but the id. On a network failure the
   * create is retried ONLY after `GET /v1/jobs` confirms the id is absent
   * (never a blind re-create — a duplicate create would leak a container).
   */
  async provision(input: DevJobProvisionInput): Promise<RunnerHandle> {
    const jobId = input.jobId;
    // Attempt 0 is the create; each further attempt first CONFIRMS the job is
    // absent (never a blind re-create) then re-creates, with a widening backoff.
    const maxAttempts = this.backoffMs.length + 1;
    let lastUnreachable: DockerBackendError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        // A prior transport failure may still have created the container; adopt
        // it rather than risk a duplicate. Confirm-absent BEFORE re-creating.
        const existing = await this.findLiveOnDaemon(jobId).catch(() => undefined);
        if (existing) return this.trackHandle(existing);
        await this.sleep(this.backoffMs[attempt - 1] ?? 0);
      }

      try {
        const res = await this.daemonFetch('POST', '/v1/jobs', {
          body: { protocol: DAEMON_PROTOCOL_VERSION, jobId, leaseTtlSec: this.leaseTtlSec },
          timeoutMs: this.provisionTimeoutMs,
        });
        if (res.ok) {
          const parsed = CreateJobResponseSchema.parse(res.json);
          return this.trackHandle({ jobId, ...parsed });
        }
        // Non-2xx: a named daemon failure. Never retried blindly — the map
        // decides terminal vs at-capacity.
        throw this.mapDaemonError(res.status, res.json, `provision job ${jobId}`);
      } catch (err) {
        const mapped = this.asBackendError(err, `provision job ${jobId}`);
        // Only a genuine transport failure is retryable-by-confirm; a mapped
        // daemon status (spec_rejected/at_capacity/engine_error) propagates as-is.
        if (mapped.code !== 'devplatform.daemon_unreachable') throw mapped;
        lastUnreachable = mapped;
      }
    }

    throw (
      lastUnreachable ??
      new DockerBackendError('devplatform.daemon_unreachable', `provision job ${jobId}: daemon unreachable`)
    );
  }

  // -------------------------------------------------------------------------
  // terminate
  // -------------------------------------------------------------------------

  /**
   * Kill + clean a job: `DELETE /v1/jobs/:jobId`. Idempotent — a 404 means the
   * container is already gone (success). A `502 daemon.cleanup_failed` did NOT
   * prove the container gone, so it is re-thrown with `keepHandle: true` and the
   * handle is RETAINED for the caller to retry (mirrors LocalProcessBackend's
   * `local_terminate_incomplete`): dropping the only handle on a live,
   * credential-bearing container is exactly the hole this refuses to open.
   */
  async terminate(handle: RunnerHandle): Promise<void> {
    if (handle.backend !== 'docker') {
      throw new DockerBackendError(
        'devplatform.wrong_backend',
        `DockerBackend cannot terminate a '${handle.backend}' handle`,
      );
    }
    const jobId = dockerJobId(handle);
    const res = await this.daemonFetch('DELETE', `/v1/jobs/${encodeURIComponent(jobId)}`, {
      timeoutMs: this.callTimeoutMs,
    });
    if (res.ok || res.status === 404) {
      this.live.delete(jobId);
      this.maybeStopRenewLoop();
      return;
    }
    const mapped = this.mapDaemonError(res.status, res.json, `terminate job ${jobId}`);
    if (mapped.keepHandle) {
      // Teardown unproven: keep the handle tracked so a later terminate/reap retries.
      this.log(
        `[dev-platform] daemon could not clean job ${jobId} (${mapped.code}); ` +
          'keeping the handle for retry',
      );
    }
    throw mapped;
  }

  // -------------------------------------------------------------------------
  // reap
  // -------------------------------------------------------------------------

  /**
   * Reconcile the middleware's tracked jobs against the daemon's live set
   * (`GET /v1/jobs`). A job this middleware still tracks that the daemon no
   * longer knows about is lost (its container died/was reaped daemon-side); its
   * handle is returned so the worker finalizes the job `stalled`
   * (`runner_lost`). A daemon read failure yields NO reaps (a transient blip
   * must never mass-finalize healthy jobs).
   */
  async reap(): Promise<RunnerHandle[]> {
    if (this.live.size === 0) return [];
    let daemonIds: Set<string>;
    try {
      daemonIds = new Set((await this.listDaemonJobs()).map((j) => j.jobId));
    } catch (err) {
      this.log(`[dev-platform] docker reap: daemon list failed (${errText(err)}); no reaps this pass`);
      return [];
    }
    const lost: RunnerHandle[] = [];
    for (const [jobId, handle] of this.live) {
      if (!daemonIds.has(jobId)) {
        this.live.delete(jobId);
        lost.push(handle);
      }
    }
    this.maybeStopRenewLoop();
    return lost;
  }

  // -------------------------------------------------------------------------
  // lease renewal
  // -------------------------------------------------------------------------

  /**
   * Renew every live job's lease (`POST /v1/jobs/:id/lease`). Called by the
   * internal ~TTL/3 loop (or directly by tests). A `404` means the daemon has
   * dropped the job — leave it in `live` so the next `reap()` finalizes it
   * rather than silently forgetting it here; any other error is logged and the
   * job is retried next tick. A live job's handle gets its refreshed
   * `leaseExpiresAt` in place.
   */
  async renewLeases(): Promise<void> {
    for (const [jobId, handle] of [...this.live]) {
      let res: DaemonResponse;
      try {
        res = await this.daemonFetch('POST', `/v1/jobs/${encodeURIComponent(jobId)}/lease`, {
          body: { protocol: DAEMON_PROTOCOL_VERSION, leaseTtlSec: this.leaseTtlSec },
          timeoutMs: this.callTimeoutMs,
        });
      } catch (err) {
        this.log(`[dev-platform] lease renew for ${jobId} failed: ${errText(err)}`);
        continue;
      }
      if (res.ok) {
        const parsed = LeaseResponseSchema.safeParse(res.json);
        if (parsed.success) handle.leaseExpiresAt = parsed.data.leaseExpiresAt;
        continue;
      }
      if (res.status === 404) {
        // Daemon dropped the job; reap() (the DB-authoritative reconciler) settles it.
        this.log(`[dev-platform] lease renew for ${jobId}: daemon reports the job gone (404)`);
        continue;
      }
      this.log(`[dev-platform] lease renew for ${jobId}: daemon HTTP ${String(res.status)}`);
    }
  }

  /** Stop the internal renewal loop (idempotent). The worker never needs this,
   *  but a graceful shutdown / test can call it. */
  stop(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Record a fresh handle, start the renewal loop if this is the first live job. */
  private trackHandle(fields: {
    jobId: string;
    containerId: string;
    networkId: string;
    volumeName: string;
    imageDigest: string;
    leaseExpiresAt: string;
  }): DockerRunnerHandle {
    const handle: DockerRunnerHandle = {
      backend: 'docker',
      id: fields.jobId,
      jobId: fields.jobId,
      containerId: fields.containerId,
      networkId: fields.networkId,
      volumeName: fields.volumeName,
      imageDigest: fields.imageDigest,
      leaseExpiresAt: fields.leaseExpiresAt,
      startedAt: this.now().toISOString(),
    };
    this.live.set(fields.jobId, handle);
    this.ensureRenewLoop();
    return handle;
  }

  private ensureRenewLoop(): void {
    if (!this.autoRenew || this.renewTimer || this.live.size === 0) return;
    this.renewTimer = setInterval(() => {
      void this.renewLeases().catch((err) =>
        this.log(`[dev-platform] lease renewal loop error: ${errText(err)}`),
      );
    }, this.renewIntervalMs);
    if (typeof this.renewTimer.unref === 'function') this.renewTimer.unref();
  }

  private maybeStopRenewLoop(): void {
    if (this.live.size === 0) this.stop();
  }

  /** `GET /v1/jobs` → the parsed live-job summaries. */
  private async listDaemonJobs(): Promise<JobSummary[]> {
    const res = await this.daemonFetch('GET', '/v1/jobs', { timeoutMs: this.callTimeoutMs });
    if (!res.ok) throw this.mapDaemonError(res.status, res.json, 'list jobs');
    return ListJobsResponseSchema.parse(res.json).jobs;
  }

  /** Find a job on the daemon by id (idempotency check for provision retry). */
  private async findLiveOnDaemon(jobId: string): Promise<{
    jobId: string;
    containerId: string;
    networkId: string;
    volumeName: string;
    imageDigest: string;
    leaseExpiresAt: string;
  } | undefined> {
    const found = (await this.listDaemonJobs()).find((j) => j.jobId === jobId);
    return found;
  }

  /**
   * One bounded daemon call: bearer auth, a single timeout spanning headers AND
   * the capped body read, `redirect: 'error'`. Returns the status + parsed JSON;
   * a transport failure throws `devplatform.daemon_unreachable`.
   */
  private async daemonFetch(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { body?: unknown; timeoutMs: number },
  ): Promise<DaemonResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.daemonBase}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/json',
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: controller.signal,
          // The daemon origin is pinned; a 30x would move the request off it.
          redirect: 'error',
        });
      } catch (err) {
        throw new DockerBackendError(
          'devplatform.daemon_unreachable',
          `daemon ${method} ${path} failed: ${errText(err)}`,
        );
      }
      const text = await readCappedBody(res, this.maxBodyBytes, controller);
      const json = text.length > 0 ? safeJsonParse(text) : undefined;
      return { ok: res.ok, status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map a non-2xx daemon status/body to a typed backend error (spec §5 taxonomy). */
  private mapDaemonError(status: number, json: unknown, ctx: string): DockerBackendError {
    const body = (json ?? {}) as DaemonErrorBody;
    const daemonCode = typeof body.code === 'string' ? body.code : undefined;
    const daemonMsg = typeof body.message === 'string' ? body.message : undefined;
    const detail = daemonMsg ?? daemonCode ?? `HTTP ${String(status)}`;

    // 400 daemon.spec_rejected — the clamp refused the container shape. Terminal.
    if (status === 400) {
      return new DockerBackendError(
        'devplatform.spec_rejected',
        `${ctx}: daemon rejected the job (${detail})`,
        { httpStatus: status },
      );
    }
    // 401/403 — a bad/absent bearer. Terminal; the operator must fix the token.
    if (status === 401 || status === 403) {
      return new DockerBackendError(
        'devplatform.daemon_unauthorized',
        `${ctx}: daemon rejected the daemon token (HTTP ${String(status)})`,
        { httpStatus: status },
      );
    }
    // 404 — the named job does not exist at the daemon. Terminal for a create;
    // callers that treat 404 as success (terminate) branch before reaching here.
    if (status === 404) {
      return new DockerBackendError(
        'devplatform.job_not_found',
        `${ctx}: daemon has no such job (${detail})`,
        { httpStatus: status },
      );
    }
    // 409 daemon.job_cancelled — a delete raced the create; the delete won.
    if (status === 409) {
      return new DockerBackendError(
        'devplatform.job_cancelled',
        `${ctx}: the job was cancelled while it was being created (${detail})`,
        { httpStatus: status },
      );
    }
    // 429 — the daemon is at capacity. NOT a job failure: retry later.
    if (status === 429) {
      return new DockerBackendError(
        'devplatform.daemon_at_capacity',
        `${ctx}: daemon is at capacity (${detail})`,
        { retryable: true, httpStatus: status },
      );
    }
    // 502 daemon.cleanup_failed — teardown unproven; keep the handle and retry.
    if (status === 502 && daemonCode === 'daemon.cleanup_failed') {
      return new DockerBackendError(
        'devplatform.cleanup_failed',
        `${ctx}: daemon could not clean up the container (${detail})`,
        { keepHandle: true, httpStatus: status },
      );
    }
    // 503 — the daemon reached the wire but its dependency (dind / policy) is
    // unreachable. Treat as a transient engine reachability failure.
    if (status === 503) {
      return new DockerBackendError(
        'devplatform.daemon_unreachable',
        `${ctx}: daemon dependency unreachable (${detail})`,
        { retryable: true, httpStatus: status },
      );
    }
    // Any other 5xx (incl. 502 policy_lookup_failed) — an engine-side fault.
    return new DockerBackendError(
      'devplatform.engine_error',
      `${ctx}: daemon engine error (HTTP ${String(status)}: ${detail})`,
      { httpStatus: status },
    );
  }

  /** Normalize a caught value into a `DockerBackendError`. */
  private asBackendError(err: unknown, ctx: string): DockerBackendError {
    if (err instanceof DockerBackendError) return err;
    if (err instanceof RunnerBackendError) {
      return new DockerBackendError(err.code, err.message);
    }
    // A zod parse failure on a 2xx body: the daemon answered but off-contract.
    return new DockerBackendError('devplatform.daemon_malformed', `${ctx}: ${errText(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Free helpers.
// ---------------------------------------------------------------------------

interface DaemonResponse {
  ok: boolean;
  status: number;
  json: unknown;
}

/** The daemon's lease bounds (daemonProtocol) are [30, 3600]; clamp into range so
 *  a misconfigured TTL never trips the wire schema at provision time. */
function clampLeaseTtl(ttl: number): number {
  const n = Number.isFinite(ttl) ? Math.trunc(ttl) : DEFAULT_LEASE_TTL_SEC;
  return Math.min(3_600, Math.max(30, n));
}

/** The jobId carried by a docker handle. Prefer the explicit field; fall back to
 *  `id` (they are equal by construction, but a DB round-trip could surface only
 *  the base `RunnerHandle`). */
function dockerJobId(handle: RunnerHandle): string {
  const asDocker = handle as Partial<DockerRunnerHandle>;
  return asDocker.jobId ?? handle.id;
}

/**
 * Read a response body under a hard byte cap, aborting the whole request the
 * moment the cap is exceeded so an oversized body never buffers to exhaustion
 * (mirrors `policyClient.readCappedBody`). Falls back to `text()` for a fetch
 * fake with no stream body.
 */
async function readCappedBody(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          try {
            await reader.cancel();
          } catch {
            // best-effort — the abort already tore the stream down.
          }
          throw new DockerBackendError(
            'devplatform.daemon_body_too_large',
            `daemon response exceeds the ${String(maxBytes)}-byte cap`,
          );
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // nothing more to read.
      }
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new DockerBackendError(
      'devplatform.daemon_body_too_large',
      `daemon response exceeds the ${String(maxBytes)}-byte cap`,
    );
  }
  return text.trim();
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
