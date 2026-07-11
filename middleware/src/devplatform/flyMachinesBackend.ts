/**
 * Epic #470 W4 — `FlyMachinesBackend`: an ephemeral Fly Machine per job (spec §2).
 *
 * The sibling of `DockerBackend`, for the hosted deployment. Where the docker
 * backend NAMES a job to a runner daemon that owns all policy, there is no daemon
 * on Fly: this backend IS the create-r. It talks the Fly Machines API directly and
 * therefore builds the machine config itself — image, guest, metadata, env — from
 * digest-pinned/operator-configured OPTIONS. It still never mints or forwards a
 * long-lived secret: the only credential it plants in the VM is the one-time runner
 * job token (`input.jobToken`), and the only auth it carries to Fly is a deploy
 * token scoped to the runner app, read from Vault per call.
 *
 * DEDICATED RUNNER APP. Machines are created in a SEPARATE Fly app
 * (`DEV_FLY_RUNNER_APP`, e.g. `odoo-bot-dev-runners`) — NEVER inside
 * `odoo-bot-middleware`. `appName` is that app; `token()` yields the deploy token
 * scoped to it. The one-time `flyctl apps create <app>` + token mint is checked at
 * boot by the WIRING (a clear "run flyctl apps create …" error), not here — this
 * backend just uses `appName`.
 *
 * NETWORKING. `phoneHomeUrl` and `apiBase` are operator-configured, non-user URLs
 * (on-Fly the apiBase is `http://_api.internal:4280/v1` and the phone-home is a
 * `.internal` 6PN address; the on-/off-Fly selection is the wiring's concern, not
 * this backend's). They are DELIBERATELY not run through `assertPublicHttpsUrl`:
 * that guard correctly REJECTS `.internal` and non-https, so guarding these would
 * break the intended internal path. The guard is for user-supplied URLs; these are
 * not user-supplied.
 *
 * EGRESS. Fly has no per-machine egress firewall. Egress enforcement is in-VM
 * nftables set by the runner shim/image — NOT configured here. This backend only
 * launches the Machine; do not look for an egress allowlist in the create config.
 *
 * KILL LAYERS (this backend implements its part of all three, spec §2):
 *   1. `terminate()` — graceful stop (SIGTERM, 15s) then force destroy.
 *   2. `reap()` — destroy machines whose job is terminal/unknown or whose lease
 *      expired (a middleware-side backstop against orphans).
 *   3. `auto_destroy: true` in the create config — the shim's wall-clock watchdog
 *      exits the VM and Fly reaps it.
 * A stop/destroy that 404s (machine already gone) is SUCCESS, not an error —
 * idempotent teardown, mirroring `DockerBackend`.
 */

import {
  RunnerBackendError,
  type RunnerBackend,
  type RunnerHandle,
} from './runnerBackend.js';
import type { DevJobProvisionInput } from './types.js';

/** Spec §8 default lease TTL (seconds) — the reap backstop deadline. */
export const DEFAULT_FLY_LEASE_TTL_SEC = 1_800;
/** A cold Fly create + image pull can be slow; everything else is tight (spec §5). */
const DEFAULT_PROVISION_TIMEOUT_MS = 120_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
/** The Machines `wait` long-poll bound (seconds) — mirrors the `?timeout=` we send. */
const DEFAULT_WAIT_TIMEOUT_SEC = 60;
/** Graceful stop grace before force-destroy (spec §2 kill layer 1). */
const STOP_GRACE = '15s';
/** Machines control-plane responses are small JSON; a body past this is hostile. */
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
/** Guest floors, so a clamp of a bad/zero request still yields a bootable machine. */
const MIN_CPUS = 1;
const MIN_MEMORY_MB = 256;
/** The metadata key reap() joins on. REQUIRED on every machine we create. */
export const JOB_ID_METADATA_KEY = 'omadia_job_id';
/** The metadata key carrying the reap deadline (ISO-8601). */
export const LEASE_METADATA_KEY = 'omadia_lease_expires_at';

/** A guest sizing request (from the job spec's `runner_guest`, resolved by wiring). */
export interface FlyGuest {
  cpus: number;
  memoryMb: number;
  /** Fly guest class; defaults to `shared`. */
  cpuKind?: string;
}

/** The Fly handle persisted to `dev_jobs.runner_handle`. `id` === jobId so the
 *  store/reap join (`runner_handle->>'id'`) works without heartbeat freshness —
 *  mirrors `DockerRunnerHandle`. */
export interface FlyRunnerHandle extends RunnerHandle {
  backend: 'fly';
  /** = jobId — the store/reap join key. */
  id: string;
  jobId: string;
  machineId: string;
  appName: string;
  image: string;
  region?: string;
  leaseExpiresAt: string;
  startedAt: string;
}

/**
 * A typed Fly failure. Extends `RunnerBackendError` so `.code` survives into
 * `dev_jobs.error`/logs, and carries the SAME two policy bits the worker acts on
 * as `DockerBackendError` (retryability convention parity):
 *   - `retryable` — a 429/503/at-capacity: retry the create later, do NOT record
 *     a job failure (`isRetryableProvisionError` keys on this exact prop).
 *   - `keepHandle` — a destroy that did not prove the machine gone: keep the
 *     handle and retry (never drop the only handle on a live, credential-bearing
 *     VM). Mirrors `DockerBackend`'s `cleanup_failed`.
 */
export class FlyMachinesBackendError extends RunnerBackendError {
  readonly retryable: boolean;
  readonly keepHandle: boolean;
  readonly httpStatus: number | undefined;

  constructor(
    code: string,
    message: string,
    opts?: { retryable?: boolean; keepHandle?: boolean; httpStatus?: number },
  ) {
    super(code, message);
    this.name = 'FlyMachinesBackendError';
    this.retryable = opts?.retryable ?? false;
    this.keepHandle = opts?.keepHandle ?? false;
    this.httpStatus = opts?.httpStatus;
  }
}

export interface FlyMachinesBackendOptions {
  /** Machines API root. `https://api.machines.dev/v1` off-Fly, `http://_api.internal:4280/v1`
   *  on-Fly. The on-/off-Fly selection is the WIRING's job; this backend takes it as given. */
  readonly apiBase: string;
  /** The DEDICATED runner app (`DEV_FLY_RUNNER_APP`) — NEVER `odoo-bot-middleware`. */
  readonly appName: string;
  /** Reads the Fly deploy token (scoped to `appName`) from Vault. Called per API
   *  operation — the token is never held on the instance. */
  readonly token: () => Promise<string>;
  /** Digest-pinned runner image (e.g. `registry.fly.io/…@sha256:…`). Never a floating tag. */
  readonly image: string;
  /** Operator-configured phone-home URL handed to the shim as env. NOT SSRF-guarded
   *  (it is intentionally a `.internal` 6PN address on Fly). */
  readonly phoneHomeUrl: string;
  /** Requested guest size (wiring resolves the job spec's `runner_guest` override into
   *  this). CLAMPED to the ceilings below at create time — a request over the ceiling is
   *  clamped, never honored. */
  readonly guest: FlyGuest;
  /** `DEV_FLY_MAX_CPUS` ceiling. */
  readonly maxCpus: number;
  /** `DEV_FLY_MAX_MEMORY_MB` ceiling. */
  readonly maxMemoryMb: number;
  /** reap()'s liveness oracle: does the middleware still consider this job active?
   *  The backend never reads the DB directly — it asks this predicate (mirrors how
   *  `DockerBackend.reap` learns liveness from the daemon list). A terminal/unknown
   *  job (predicate → false) is an orphan to destroy. */
  readonly isJobActive: (jobId: string) => boolean | Promise<boolean>;
  /** Fly region to place the machine (optional — Fly picks one if absent). */
  readonly region?: string;
  /** Lease TTL (seconds) → the reap deadline stamped into machine metadata. Default 1800. */
  readonly leaseTtlSec?: number;
  /** Test seam. Default global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly log?: (msg: string) => void;
  readonly provisionTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly waitTimeoutSec?: number;
  readonly maxBodyBytes?: number;
}

/** Minimal shape of a Fly machine as returned by create/list. */
interface FlyMachine {
  id?: unknown;
  region?: unknown;
  config?: { metadata?: Record<string, unknown> | null } | null;
}

interface FlyResponse {
  ok: boolean;
  status: number;
  json: unknown;
}

/**
 * Clamp a requested guest to the ceilings — a request over the ceiling is clamped,
 * NOT honored (spec §2). Floors keep a zero/negative/NaN request bootable. Pure so
 * the clamp is unit-testable in isolation.
 */
export function clampGuest(
  requested: FlyGuest,
  ceilings: { maxCpus: number; maxMemoryMb: number },
): { cpus: number; memoryMb: number; cpuKind: string } {
  const cpus = clampInt(requested.cpus, MIN_CPUS, ceilings.maxCpus);
  const memoryMb = clampInt(requested.memoryMb, MIN_MEMORY_MB, ceilings.maxMemoryMb);
  return { cpus, memoryMb, cpuKind: requested.cpuKind ?? 'shared' };
}

export class FlyMachinesBackend implements RunnerBackend {
  readonly kind = 'fly' as const;

  private readonly apiBase: string;
  private readonly appName: string;
  private readonly token: () => Promise<string>;
  private readonly image: string;
  private readonly phoneHomeUrl: string;
  private readonly guest: FlyGuest;
  private readonly maxCpus: number;
  private readonly maxMemoryMb: number;
  private readonly isJobActive: (jobId: string) => boolean | Promise<boolean>;
  private readonly region: string | undefined;
  private readonly leaseTtlSec: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly provisionTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly waitTimeoutSec: number;
  private readonly maxBodyBytes: number;

  /** Live handles keyed by jobId — the local mirror of what we launched. reap()
   *  is authoritative off the Fly machine list, but a returned handle also lives
   *  here so terminate/introspection do not need a round-trip. */
  private readonly live = new Map<string, FlyRunnerHandle>();

  constructor(opts: FlyMachinesBackendOptions) {
    if (!opts.apiBase || opts.apiBase.trim() === '') {
      throw new FlyMachinesBackendError(
        'devplatform.fly_api_base_required',
        'FlyMachinesBackend requires the Machines apiBase',
      );
    }
    if (!opts.appName || opts.appName.trim() === '') {
      throw new FlyMachinesBackendError(
        'devplatform.fly_app_required',
        'FlyMachinesBackend requires the dedicated runner appName (DEV_FLY_RUNNER_APP)',
      );
    }
    if (!opts.image || opts.image.trim() === '') {
      throw new FlyMachinesBackendError(
        'devplatform.fly_image_required',
        'FlyMachinesBackend requires a digest-pinned runner image',
      );
    }
    this.apiBase = opts.apiBase.replace(/\/+$/, '');
    this.appName = opts.appName;
    this.token = opts.token;
    this.image = opts.image;
    this.phoneHomeUrl = opts.phoneHomeUrl;
    this.guest = opts.guest;
    this.maxCpus = opts.maxCpus;
    this.maxMemoryMb = opts.maxMemoryMb;
    this.isJobActive = opts.isJobActive;
    this.region = opts.region;
    this.leaseTtlSec = clampLeaseTtl(opts.leaseTtlSec ?? DEFAULT_FLY_LEASE_TTL_SEC);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((msg) => console.warn(msg));
    this.provisionTimeoutMs = opts.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.waitTimeoutSec = opts.waitTimeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC;
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  // -------------------------------------------------------------------------
  // provision
  // -------------------------------------------------------------------------

  /**
   * Launch an ephemeral Machine for a job: `POST /apps/{app}/machines` then
   * `GET …/{id}/wait?state=started`. The create config carries the digest-pinned
   * image, the ceiling-CLAMPED guest, `metadata.omadia_job_id` (reap keys on it),
   * `auto_destroy: true`, `restart.policy: no`, and ONLY the env the shim needs
   * (phone-home URL + the one-time runner token — no long-lived secret).
   */
  async provision(input: DevJobProvisionInput): Promise<RunnerHandle> {
    const jobId = input.jobId;
    const token = await this.token();
    const leaseExpiresAt = new Date(this.now().getTime() + this.leaseTtlSec * 1_000).toISOString();

    const createBody = this.buildCreateConfig(input, leaseExpiresAt);

    const created = await this.flyFetch('POST', `/apps/${enc(this.appName)}/machines`, {
      token,
      body: createBody,
      timeoutMs: this.provisionTimeoutMs,
    });
    if (!created.ok) {
      throw this.mapFlyError(created.status, created.json, `provision job ${jobId}`);
    }
    const machineId = machineIdOf(created.json);
    if (!machineId) {
      throw new FlyMachinesBackendError(
        'devplatform.fly_malformed_response',
        `provision job ${jobId}: create returned no machine id`,
      );
    }

    // Block until the machine reports `started` (or the bound elapses). A machine
    // that never starts is destroyed so a failed provision never leaks a VM.
    const waited = await this.flyFetch(
      'GET',
      `/apps/${enc(this.appName)}/machines/${enc(machineId)}/wait?state=started&timeout=${String(this.waitTimeoutSec)}`,
      { token, timeoutMs: (this.waitTimeoutSec + 5) * 1_000 },
    );
    if (!waited.ok) {
      // Best-effort teardown of the machine that would not start, then surface the
      // failure with the sibling's retryability convention.
      await this.destroyMachine(machineId, token).catch(() => {});
      throw this.mapFlyError(waited.status, waited.json, `provision job ${jobId}: wait for started`);
    }

    const region = typeof (created.json as FlyMachine).region === 'string'
      ? ((created.json as FlyMachine).region as string)
      : this.region;
    return this.trackHandle({ jobId, machineId, image: this.image, region, leaseExpiresAt });
  }

  // -------------------------------------------------------------------------
  // terminate
  // -------------------------------------------------------------------------

  /**
   * Kill a job's machine: graceful stop (SIGTERM, 15s) then force destroy
   * (`DELETE …?force=true`). Idempotent — a 404 on either call means the machine
   * is already gone (success). A destroy that fails for any other reason did NOT
   * prove the machine gone, so it re-throws with `keepHandle: true` and the handle
   * is RETAINED (mirrors `DockerBackend`'s `cleanup_failed`): dropping the only
   * handle on a live, credential-bearing VM is exactly the hole this refuses.
   */
  async terminate(handle: RunnerHandle): Promise<void> {
    if (handle.backend !== 'fly') {
      throw new FlyMachinesBackendError(
        'devplatform.wrong_backend',
        `FlyMachinesBackend cannot terminate a '${handle.backend}' handle`,
      );
    }
    const fly = asFlyHandle(handle);
    if (!fly) {
      throw new FlyMachinesBackendError(
        'devplatform.malformed_handle',
        `FlyMachinesBackend cannot terminate a malformed fly handle (id='${handle.id}')`,
      );
    }
    const token = await this.token();

    // Graceful stop first (best-effort: a 404 or a stop error still proceeds to the
    // authoritative force-destroy — the SIGTERM is a courtesy, the destroy is the kill).
    const stop = await this.flyFetch(
      'POST',
      `/apps/${enc(this.appName)}/machines/${enc(fly.machineId)}/stop`,
      { token, body: { timeout: STOP_GRACE }, timeoutMs: this.callTimeoutMs },
    ).catch((err: unknown) => {
      this.log(`[dev-platform] fly stop for ${fly.jobId} failed (${errText(err)}); proceeding to destroy`);
      return undefined;
    });
    if (stop && !stop.ok && stop.status !== 404) {
      this.log(`[dev-platform] fly stop for ${fly.jobId}: HTTP ${String(stop.status)}; proceeding to destroy`);
    }

    const destroy = await this.destroyMachine(fly.machineId, token);
    if (destroy.ok || destroy.status === 404) {
      this.live.delete(fly.jobId);
      return;
    }
    // Destroy did not prove the machine gone: keep the handle, let a later
    // terminate/reap retry. Never forget a live, credential-bearing VM.
    this.log(
      `[dev-platform] fly destroy for ${fly.jobId} failed (HTTP ${String(destroy.status)}); ` +
        'keeping the handle for retry',
    );
    throw this.mapFlyError(destroy.status, destroy.json, `terminate job ${fly.jobId}`, {
      keepHandle: true,
    });
  }

  // -------------------------------------------------------------------------
  // reap
  // -------------------------------------------------------------------------

  /**
   * Backstop kill layer: list every machine in the runner app and destroy the ones
   * whose job is terminal/unknown (the injected `isJobActive` predicate says false)
   * OR whose lease deadline has passed — leaving genuinely active jobs untouched.
   * Returns the handles it destroyed so the worker can settle those rows.
   *
   * A machine with no `omadia_job_id` metadata is NOT ours — we never touch it. A
   * list read failure yields NO reaps (a transient blip must never mass-destroy
   * live machines — same discipline as `DockerBackend.reap`).
   */
  async reap(): Promise<RunnerHandle[]> {
    const token = await this.token();
    let machines: FlyMachine[];
    try {
      machines = await this.listMachines(token);
    } catch (err) {
      this.log(`[dev-platform] fly reap: machine list failed (${errText(err)}); no reaps this pass`);
      return [];
    }

    const nowMs = this.now().getTime();
    const reaped: RunnerHandle[] = [];
    for (const machine of machines) {
      const jobId = jobIdOf(machine);
      const machineId = machineIdOf(machine);
      // Not one of ours (missing the required metadata key) → never touch it.
      if (!jobId || !machineId) continue;

      const active = await this.isJobActive(jobId);
      const leaseExpiresAt = leaseOf(machine);
      const leaseExpired = leaseExpiresAt !== undefined && Date.parse(leaseExpiresAt) <= nowMs;
      if (active && !leaseExpired) continue; // genuinely live — leave it running.

      const destroy = await this.destroyMachine(machineId, token).catch((err: unknown) => {
        this.log(`[dev-platform] fly reap: destroy ${machineId} failed (${errText(err)})`);
        return undefined;
      });
      if (destroy && (destroy.ok || destroy.status === 404)) {
        this.live.delete(jobId);
        reaped.push(this.handleFrom(jobId, machineId, leaseExpiresAt ?? this.now().toISOString(), machine));
      }
    }
    return reaped;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * The Machines create body (spec §2). `metadata.omadia_job_id` is REQUIRED (reap
   * keys on it); the guest is ceiling-clamped; `auto_destroy` + `restart.policy: no`
   * make the shim watchdog the third kill layer. env carries ONLY what the shim
   * needs to phone home and authenticate as this one job — never a long-lived secret.
   */
  private buildCreateConfig(input: DevJobProvisionInput, leaseExpiresAt: string): unknown {
    const guest = clampGuest(this.guest, { maxCpus: this.maxCpus, maxMemoryMb: this.maxMemoryMb });
    return {
      ...(this.region ? { region: this.region } : {}),
      config: {
        image: this.image,
        guest: { cpu_kind: guest.cpuKind, cpus: guest.cpus, memory_mb: guest.memoryMb },
        // REQUIRED: reap() joins terminal/lease-expired jobs to machines on this key.
        metadata: {
          [JOB_ID_METADATA_KEY]: input.jobId,
          [LEASE_METADATA_KEY]: leaseExpiresAt,
        },
        env: {
          OMADIA_JOB_ID: input.jobId,
          // The one-time runner token (NOT a long-lived secret). The shim uses it to
          // pull its own spec and report results.
          OMADIA_JOB_TOKEN: input.jobToken,
          OMADIA_BASE_URL: input.baseUrl,
          // Operator-configured (may be a `.internal` 6PN URL) — see the file header
          // on why this is NOT routed through assertPublicHttpsUrl.
          OMADIA_PHONE_HOME_URL: this.phoneHomeUrl,
          OMADIA_LEASE_EXPIRES_AT: leaseExpiresAt,
        },
        // Kill layer 3: the shim's wall-clock watchdog exits and Fly auto-reaps.
        auto_destroy: true,
        // An ephemeral per-job VM must never be resurrected on exit.
        restart: { policy: 'no' },
      },
    };
  }

  private trackHandle(fields: {
    jobId: string;
    machineId: string;
    image: string;
    region: string | undefined;
    leaseExpiresAt: string;
  }): FlyRunnerHandle {
    const handle: FlyRunnerHandle = {
      backend: 'fly',
      id: fields.jobId,
      jobId: fields.jobId,
      machineId: fields.machineId,
      appName: this.appName,
      image: fields.image,
      ...(fields.region ? { region: fields.region } : {}),
      leaseExpiresAt: fields.leaseExpiresAt,
      startedAt: this.now().toISOString(),
    };
    this.live.set(fields.jobId, handle);
    return handle;
  }

  /** Rebuild a handle for a reaped machine (it may not be in `this.live` after a
   *  middleware restart — reap reads the Fly list, the authority on what exists). */
  private handleFrom(
    jobId: string,
    machineId: string,
    leaseExpiresAt: string,
    machine: FlyMachine,
  ): FlyRunnerHandle {
    const existing = this.live.get(jobId);
    if (existing) return existing;
    const region = typeof machine.region === 'string' ? machine.region : this.region;
    return {
      backend: 'fly',
      id: jobId,
      jobId,
      machineId,
      appName: this.appName,
      image: this.image,
      ...(region ? { region } : {}),
      leaseExpiresAt,
      startedAt: this.now().toISOString(),
    };
  }

  /** Force-destroy one machine (`DELETE …?force=true`). */
  private async destroyMachine(machineId: string, token: string): Promise<FlyResponse> {
    return this.flyFetch(
      'DELETE',
      `/apps/${enc(this.appName)}/machines/${enc(machineId)}?force=true`,
      { token, timeoutMs: this.callTimeoutMs },
    );
  }

  /** `GET /apps/{app}/machines` → the machine array (Fly returns a bare JSON array). */
  private async listMachines(token: string): Promise<FlyMachine[]> {
    const res = await this.flyFetch('GET', `/apps/${enc(this.appName)}/machines`, {
      token,
      timeoutMs: this.callTimeoutMs,
    });
    if (!res.ok) throw this.mapFlyError(res.status, res.json, 'list machines');
    if (!Array.isArray(res.json)) {
      throw new FlyMachinesBackendError(
        'devplatform.fly_malformed_response',
        'list machines: expected a JSON array',
      );
    }
    return res.json as FlyMachine[];
  }

  /**
   * One bounded Machines call: Vault-bearer auth, a single timeout spanning headers
   * AND the capped body read, `redirect: 'error'` (the API origin is pinned; a 30x
   * would move the request off it). A transport failure throws `fly_unreachable`.
   */
  private async flyFetch(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { token: string; body?: unknown; timeoutMs: number },
  ): Promise<FlyResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.apiBase}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${opts.token}`,
            accept: 'application/json',
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch (err) {
        throw new FlyMachinesBackendError(
          'devplatform.fly_unreachable',
          `fly ${method} ${path} failed: ${errText(err)}`,
        );
      }
      const text = await readCappedBody(res, this.maxBodyBytes, controller);
      const json = text.length > 0 ? safeJsonParse(text) : undefined;
      return { ok: res.ok, status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Map a non-2xx Fly status/body to a typed error, matching the sibling's
   * retryability convention (`DockerBackend.mapDaemonError`):
   *   - 401/403 → terminal auth failure (fix the deploy token).
   *   - 404 → the machine is gone (callers that treat this as success branch first).
   *   - 400/422 → Fly rejected the machine spec. Terminal.
   *   - 429 → rate-limited / at-capacity. RETRYABLE (not a job failure).
   *   - 5xx → engine fault. 503 is retryable; other 5xx are terminal engine errors.
   */
  private mapFlyError(
    status: number,
    json: unknown,
    ctx: string,
    extra?: { keepHandle?: boolean },
  ): FlyMachinesBackendError {
    const detail = flyErrorDetail(json, status);
    const keepHandle = extra?.keepHandle ?? false;
    if (status === 401 || status === 403) {
      return new FlyMachinesBackendError(
        'devplatform.fly_unauthorized',
        `${ctx}: Fly rejected the deploy token (HTTP ${String(status)})`,
        { httpStatus: status, keepHandle },
      );
    }
    if (status === 404) {
      return new FlyMachinesBackendError(
        'devplatform.fly_machine_not_found',
        `${ctx}: Fly has no such machine (${detail})`,
        { httpStatus: status, keepHandle },
      );
    }
    if (status === 422 || status === 400) {
      return new FlyMachinesBackendError(
        'devplatform.fly_spec_rejected',
        `${ctx}: Fly rejected the machine spec (${detail})`,
        { httpStatus: status, keepHandle },
      );
    }
    if (status === 429) {
      return new FlyMachinesBackendError(
        'devplatform.fly_at_capacity',
        `${ctx}: Fly is rate-limited / at capacity (${detail})`,
        { retryable: true, httpStatus: status, keepHandle },
      );
    }
    if (status === 503) {
      return new FlyMachinesBackendError(
        'devplatform.fly_unreachable',
        `${ctx}: Fly dependency unavailable (${detail})`,
        { retryable: true, httpStatus: status, keepHandle },
      );
    }
    return new FlyMachinesBackendError(
      'devplatform.fly_engine_error',
      `${ctx}: Fly engine error (HTTP ${String(status)}: ${detail})`,
      { httpStatus: status, keepHandle },
    );
  }
}

// ---------------------------------------------------------------------------
// Free helpers.
// ---------------------------------------------------------------------------

/** Narrow a persisted handle to this backend's shape (mirrors `asDockerHandle`).
 *  Returns null for a foreign, truncated, or hand-edited handle, or one whose
 *  `id`/`jobId` disagree (that mismatch is dangerous — terminate would act on the
 *  wrong machine). */
function asFlyHandle(handle: RunnerHandle): FlyRunnerHandle | null {
  const h = handle as Partial<FlyRunnerHandle>;
  if (h.backend !== 'fly') return null;
  for (const key of ['id', 'jobId', 'machineId', 'appName', 'image'] as const) {
    if (typeof h[key] !== 'string' || h[key] === '') return null;
  }
  if (h.id !== h.jobId) return null;
  return h as FlyRunnerHandle;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(max, Math.max(min, n));
}

/** Fly's machine lease bounds are wide; clamp to a sane [30, 86400] window so a
 *  misconfigured TTL never yields a negative/absurd deadline. */
function clampLeaseTtl(ttl: number): number {
  const n = Number.isFinite(ttl) ? Math.trunc(ttl) : DEFAULT_FLY_LEASE_TTL_SEC;
  return Math.min(86_400, Math.max(30, n));
}

function machineIdOf(json: unknown): string | undefined {
  const id = (json as FlyMachine | null)?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function jobIdOf(machine: FlyMachine): string | undefined {
  const v = machine.config?.metadata?.[JOB_ID_METADATA_KEY];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function leaseOf(machine: FlyMachine): string | undefined {
  const v = machine.config?.metadata?.[LEASE_METADATA_KEY];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function flyErrorDetail(json: unknown, status: number): string {
  const body = (json ?? {}) as { error?: unknown; message?: unknown };
  if (typeof body.error === 'string') return body.error;
  if (typeof body.message === 'string') return body.message;
  return `HTTP ${String(status)}`;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Read a response body under a hard byte cap, aborting the whole request the moment
 * the cap is exceeded so an oversized body never buffers to exhaustion (mirrors
 * `DockerBackend.readCappedBody`). Falls back to `text()` for a fetch fake with no
 * stream body.
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
          throw new FlyMachinesBackendError(
            'devplatform.fly_body_too_large',
            `Fly response exceeds the ${String(maxBytes)}-byte cap`,
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
    throw new FlyMachinesBackendError(
      'devplatform.fly_body_too_large',
      `Fly response exceeds the ${String(maxBytes)}-byte cap`,
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
