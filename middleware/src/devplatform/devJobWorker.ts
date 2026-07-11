/**
 * Epic #470 W0 — DevJobWorker: the in-process control loop for the job spine
 * (spec §4/§5/§8). One tick does four things, in this order:
 *
 *   1. Apply — a job the runner left in `applying` is committed host-side via
 *      `DiffApplyService` (the runner never pushed; it uploaded a diff): success
 *      ⇒ `done` + PR url, failure ⇒ `failed` with the diff artifact retained for
 *      the `POST /jobs/:id/apply` retry. Runs FIRST so a normally-completed
 *      apply is never pre-empted by the liveness sweeps below.
 *   2. Enforce — stale heartbeat ⇒ `stalled`, past wall-clock ⇒ `budget_exceeded`.
 *   3. Reap — dead/orphan runners from each backend, finalized `stalled` once.
 *   4. Claim — up to `DEV_PLATFORM_MAX_CONCURRENT_JOBS` queued jobs (each claim
 *      stamps a fresh `randomUUID()` lease), admits the auth mode at the boundary
 *      (spec §6b — the create route gives a good error, the worker is the gate),
 *      and provisions a runner backend.
 *
 * `applying` is a host-side phase with NO live runner (the shim posted its diff
 * and exited 0 by design), so Enforce and Reap both skip it via
 * `isHostSideApplyPhase` — otherwise a reaped-dead handle or stale heartbeat
 * finalizes it `stalled` and the PR is lost (apply refuses to retry `stalled`).
 *
 * The one hard invariant: EVERY terminal transition routes through
 * `finalizeDevJob`. The worker owns the terminate dispatch and the `onError`
 * sink, so a `terminate()` that throws `devplatform.local_terminate_incomplete`
 * (the local backend deliberately retaining a workspace whose runner would not
 * confirm exit) still finalizes the job and is logged — never swallowed.
 */

import { randomUUID } from 'node:crypto';

import { DiffApplyError, type ApplyInput, type ApplyResult } from './diffApplyService.js';
import type { PolicyVerdict } from './policy/diffPolicyEngine.js';
import {
  CredentialRevokerRegistry,
  finalizeDevJob,
  type CredentialRevoker,
  type FinalizeContext,
  type FinalizeStore,
} from './finalizeDevJob.js';
import {
  RunnerBackendError,
  isRetryableProvisionError,
  type DevJobProvisionContext,
} from './runnerBackend.js';
// Pure policy + wire helpers live in `devJobWorkerPolicy.ts` (keeps this file
// under the 500-line guideline); import from there, not here.
import {
  DevJobWorkerError,
  assertAuthModeAdmissible,
  isHostSideApplyPhase,
  splitDiffBundle,
} from './devJobWorkerPolicy.js';
import type {
  DevJob,
  DevJobArtifact,
  DevJobStatus,
  DevRepo,
  RunnerBackend,
  RunnerBackendKind,
  RunnerHandle,
} from './types.js';

/** Spec §10 defaults. */
export const DEFAULT_MAX_CONCURRENT_JOBS = 1;
export const DEFAULT_JOB_WALL_CLOCK_MS = 1_800_000; // 30 min
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 120_000; // 2 min
export const DEFAULT_WORKER_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Injected seams. The real `DevJobStore` satisfies `DevJobWorkerStore` and the
// real `DiffApplyService` satisfies `DevJobApplyService`; tests inject fakes.
// ---------------------------------------------------------------------------

/** The store surface the worker drives. Extends `FinalizeStore` so the SAME
 *  object backs both the reads and the single terminal choke point. */
export interface DevJobWorkerStore extends FinalizeStore {
  /** Atomically claim the oldest queued job, stamping `claimedBy` as the lease. */
  claimNextQueued(claimedBy: string): Promise<DevJob | null>;
  /** Lease-fenced rewind of a claim back to `queued` (0 rows ⇒ lease lost). */
  releaseClaim(jobId: string, claimedBy: string): Promise<boolean>;
  /** Lease-fenced attach of the backend handle (0 rows ⇒ lease lost, throws). */
  setRunnerHandle(jobId: string, claimedBy: string, handle: RunnerHandle): Promise<void>;
  /** Read jobs by status — the worker uses `{ status: 'applying' }`. */
  listJobs(filter: { status?: DevJobStatus; limit?: number }): Promise<DevJob[]>;
  /** Count jobs currently occupying a runner slot (provisioning/running/…). The
   *  concurrency gate reads this so a restart never over-provisions. */
  countActiveJobs(): Promise<number>;
  /** The uploaded diff bundle, fetched at apply time. */
  getArtifact(id: string): Promise<DevJobArtifact | null>;
  /** The still-active job carrying a given runner handle id — the reap loop maps
   *  a reaped handle back to its row without depending on heartbeat freshness (a
   *  runner can die between beats, so a stall scan would miss it). */
  findActiveByHandleId(handleId: string): Promise<DevJob | null>;
  /** Active jobs whose last sign of life predates `cutoff` — stall candidates. */
  findStalled(cutoff: Date): Promise<DevJob[]>;
  /** Active jobs started before `startedBefore` — over wall-clock budget. */
  findOverWallClock(startedBefore: Date): Promise<DevJob[]>;
}

/** Repo lookup — admission facts (runsTests) and apply targets (owner/name/base). */
export interface DevJobWorkerRepoStore {
  getRepo(id: string): Promise<DevRepo | null>;
}

/** The host-side apply (spec §8). `DiffApplyService` satisfies this structurally. */
export interface DevJobApplyService {
  apply(input: ApplyInput): Promise<ApplyResult>;
}

/** The result of a host-side apply. `applied` → a PR; `gated` → the AUTHORITATIVE
 *  diff policy parked the job for a human (spec §6), no PR. A `deny` is NOT an
 *  outcome here — it throws, and the worker finalizes the job `failed`. */
export type ApplyJobOutcome = { prUrl: string } | { gated: true; gateId: string };

/** How the worker disposes of a non-`allow` diff-policy verdict. Injected by the
 *  wiring, which closes over the gate store, job store, and token revoker. Absent
 *  in unit tests that never exercise a policy gate/deny — those still finalize
 *  `failed`, unchanged (the policy engine only runs inside the real
 *  `DiffApplyService`, which those tests do not use). */
export interface DiffPolicyGateHandler {
  /** Persist findings, open a `diff_policy` human gate, park the job `waiting`,
   *  revoke the (already-exited) runner's token. Returns the gate id. */
  onGate(job: DevJob, verdict: PolicyVerdict): Promise<{ gateId: string }>;
  /** Persist findings for the audit trail. The worker then finalizes `failed`
   *  (deny is final — no human override). */
  onDeny(job: DevJob, verdict: PolicyVerdict): Promise<void>;
}

/**
 * Mint the one-time runner token and pin the job's `branch` + `base_sha` before
 * provision (all persisted lease-fenced), returning the plaintext token + the
 * refreshed job. The create route discards the plaintext of its placeholder
 * token, so the token the backend hands the runner is minted HERE. The mechanics
 * (store columns, forge sha resolution) belong to the wiring unit; the worker
 * only needs the token + pinned job back.
 */
export type PrepareProvision = (
  job: DevJob,
  lease: string,
  repo: DevRepo,
) => Promise<{ token: string; job: DevJob }>;

export interface DevJobWorkerDeps {
  store: DevJobWorkerStore;
  repoStore: DevJobWorkerRepoStore;
  /** Backends dispatched by `.kind`. W0 ships `local`; a duplicate kind is a
   *  wiring error and rejected in the constructor. */
  backends: readonly RunnerBackend[];
  applyService: DevJobApplyService;
  /** Disposes of a non-`allow` diff-policy verdict (gate → park; deny → audit).
   *  Absent ⇒ a policy gate/deny finalizes `failed` like any other apply error. */
  policyGate?: DiffPolicyGateHandler;
  prepareProvision: PrepareProvision;
  /** The base url the runner phones home to (`DEV_PLATFORM_RUNNER_BASE_URL`). */
  baseUrl: string;
  /** Credential revokers passed to every `finalizeDevJob` (W0: none). */
  revokers?: CredentialRevokerRegistry | CredentialRevoker[];
  /** `DEV_PLATFORM_MAX_CONCURRENT_JOBS`. */
  maxConcurrent?: number;
  /** `DEV_PLATFORM_JOB_WALL_CLOCK_MS`. */
  wallClockMs?: number;
  /** `DEV_PLATFORM_HEARTBEAT_TIMEOUT_MS`. */
  heartbeatTimeoutMs?: number;
  /** `DEV_PLATFORM_SUBSCRIPTION_MODE`. */
  subscriptionModeEnabled?: boolean;
  intervalMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

// The worker.

export class DevJobWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  /** Jobs mid-apply this process — never apply the same job twice at once. */
  private readonly applying = new Set<string>();
  private readonly backends = new Map<RunnerBackendKind, RunnerBackend>();
  private readonly revokers: CredentialRevokerRegistry;
  private readonly maxConcurrent: number;
  private readonly wallClockMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly subscriptionModeEnabled: boolean;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: DevJobWorkerDeps) {
    for (const backend of deps.backends) {
      if (this.backends.has(backend.kind)) {
        throw new DevJobWorkerError(
          'devplatform.duplicate_backend',
          `two backends registered for kind '${backend.kind}'`,
        );
      }
      this.backends.set(backend.kind, backend);
    }
    this.revokers = toRegistry(deps.revokers);
    this.maxConcurrent = Math.max(1, Math.trunc(deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_JOBS));
    this.wallClockMs = deps.wallClockMs ?? DEFAULT_JOB_WALL_CLOCK_MS;
    this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.subscriptionModeEnabled = deps.subscriptionModeEnabled ?? false;
    this.intervalMs = deps.intervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((msg) => console.warn(msg));
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log('[dev-platform] job worker started (claim + enforce + reap + apply)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One control-loop pass. Non-overlapping: a slow tick never races itself. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // Apply FIRST: an `applying` job has no live runner, so commit it host-side
      // before any liveness sweep runs — defense in depth behind the
      // `isHostSideApplyPhase` carve-out in enforceTimeouts/reapBackends.
      await this.applyReady();
      await this.enforceTimeouts();
      await this.reapBackends();
      await this.claimAndProvision();
    } catch (err) {
      this.log(`[dev-platform] worker tick error: ${errText(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** The single terminal-transition path the worker uses. Builds the
   *  `finalizeDevJob` deps — terminate dispatch + the `onError` sink — so a
   *  failing terminate/revoke/event is logged, never swallowed, and never blocks
   *  the status flip. */
  async finalize(jobId: string, status: DevJobStatus, ctx?: FinalizeContext): Promise<DevJob | null> {
    return finalizeDevJob(
      {
        store: this.deps.store,
        terminate: (handle) => this.terminateHandle(handle),
        revokers: this.revokers,
        onError: (err, phase) =>
          this.log(`[dev-platform] finalize(${jobId}→${status}) ${phase} side-effect failed: ${errText(err)}`),
      },
      jobId,
      status,
      ctx,
    );
  }

  /** Stale heartbeat ⇒ `stalled`; past wall-clock ⇒ `budget_exceeded`. Both via
   *  `finalizeDevJob`. Wall-clock runs first so a job that is BOTH over budget
   *  and quiet is recorded with the more specific budget reason; the stall pass
   *  then no-ops on it (finalize is idempotent). */
  async enforceTimeouts(): Promise<void> {
    const now = this.now().getTime();
    // Skip `applying` jobs — no runner to heartbeat (header + `isHostSideApplyPhase`).
    const overBudget = (await this.deps.store.findOverWallClock(new Date(now - this.wallClockMs)))
      .filter((job) => !isHostSideApplyPhase(job.status));
    for (const job of overBudget) {
      await this.finalize(job.id, 'budget_exceeded', {
        reason: 'wall_clock_exceeded',
        error: `job exceeded its ${String(this.wallClockMs)}ms wall-clock budget`,
      });
    }

    const stalled = (await this.deps.store.findStalled(new Date(now - this.heartbeatTimeoutMs)))
      .filter((job) => !isHostSideApplyPhase(job.status));
    for (const job of stalled) {
      await this.finalize(job.id, 'stalled', {
        reason: 'heartbeat_timeout',
        error: `no runner heartbeat within ${String(this.heartbeatTimeoutMs)}ms`,
      });
    }
  }

  /** Ask each backend for dead/orphan runners; finalize each reaped job as
   *  `stalled` exactly once. A handle a previous tick already finalized is a
   *  no-op here (finalize idempotency), so a job is never double-counted. */
  async reapBackends(): Promise<void> {
    for (const backend of this.backends.values()) {
      let reaped: RunnerHandle[];
      try {
        reaped = await backend.reap();
      } catch (err) {
        this.log(`[dev-platform] reap('${backend.kind}') failed: ${errText(err)}`);
        continue;
      }
      for (const handle of reaped) {
        const job = await this.jobForHandle(handle);
        if (!job) continue;
        // Reaped `applying` job = normal completion, not a stall (see header).
        if (isHostSideApplyPhase(job.status)) continue;
        await this.finalize(job.id, 'stalled', {
          reason: 'runner_reaped',
          error: `runner ${handle.id} was reaped (dead or orphaned)`,
        });
      }
    }
  }

  /** Claim up to the free-slot count and provision each. Slots = the concurrency
   *  cap minus the jobs already occupying a runner, so a restart mid-run never
   *  over-provisions. */
  async claimAndProvision(): Promise<void> {
    const active = await this.deps.store.countActiveJobs();
    let slots = this.maxConcurrent - active;
    while (slots > 0) {
      let claimed: DevJob | null;
      try {
        claimed = await this.deps.store.claimNextQueued(randomUUID());
      } catch (err) {
        this.log(`[dev-platform] claim failed: ${errText(err)}`);
        return;
      }
      if (!claimed) return; // queue drained
      slots--;
      await this.provisionOne(claimed);
    }
  }

  /** Admit, mint the token + pin the tree, provision a backend, attach the
   *  handle. Any failure finalizes the job `failed` — never leaves a claimed
   *  job wedged. */
  private async provisionOne(job: DevJob): Promise<void> {
    const lease = job.claimedBy;
    if (!lease) {
      // Should never happen — claimNextQueued always stamps the lease.
      await this.finalize(job.id, 'failed', { reason: 'no_lease', error: 'claimed job has no lease token' });
      return;
    }
    try {
      const repo = await this.deps.repoStore.getRepo(job.repoId);
      if (!repo) {
        throw new DevJobWorkerError('devplatform.repo_not_found', `job repo '${job.repoId}' not found`);
      }

      // Auth-mode admission at the boundary (spec §6b) — the create route also
      // checks, but this is where a runner is actually about to be born.
      assertAuthModeAdmissible(job, repo, { subscriptionModeEnabled: this.subscriptionModeEnabled });

      const backend = this.backends.get(job.backend);
      if (!backend) {
        throw new DevJobWorkerError(
          'devplatform.no_backend',
          `no runner backend registered for kind '${job.backend}'`,
        );
      }

      const prepared = await this.deps.prepareProvision(job, lease, repo);
      const provInput: DevJobProvisionContext = {
        jobId: job.id,
        jobToken: prepared.token,
        baseUrl: this.deps.baseUrl,
        source: job.source,
        repo: { runsTests: repo.runsTests },
      };

      let handle: RunnerHandle;
      try {
        handle = await backend.provision(provInput);
      } catch (err) {
        if (isRetryableProvisionError(err)) {
          // "Not now", not "broken": the daemon is at capacity. Nothing was
          // spawned, so rewind the claim and let the next poll re-take the row.
          // Finalizing here would surface a queue-depth condition as a failed job.
          const released = await this.deps.store.releaseClaim(job.id, lease);
          this.log(
            `[dev-platform] job ${job.id} requeued (${errText(err)})` +
              (released ? '' : ' — lease already lost, left alone'),
          );
          return;
        }
        // Nothing spawned (or the backend refused): finalize failed, no handle.
        await this.finalize(job.id, 'failed', { reason: 'provision_failed', error: errText(err) });
        return;
      }

      try {
        await this.deps.store.setRunnerHandle(job.id, lease, handle);
      } catch (err) {
        // Lease lost between claim and attach: tear down the now-orphaned runner
        // but do NOT finalize — the row belongs to whoever holds the lease, and
        // the enforcement sweep reaps it if it is truly orphaned. Never swallow.
        this.log(
          `[dev-platform] job ${job.id} lease lost after provision (${errText(err)}); terminating orphaned runner ${handle.id}`,
        );
        try {
          await this.terminateHandle(handle);
        } catch (termErr) {
          // The teardown itself failed. Do NOT let this reach the outer catch: it
          // would finalize a row we no longer own, with no handle recorded, while
          // the runner is still up. The backend has stopped renewing this handle's
          // lease, so the daemon's own reaper destroys it within the TTL — that
          // lease is the durable backstop precisely for this case.
          this.log(
            `[dev-platform] job ${job.id}: could not terminate orphaned runner ${handle.id} ` +
              `(${errText(termErr)}); its lease is no longer renewed, so the runner reaper will destroy it`,
          );
        }
        return;
      }
    } catch (err) {
      // Admission / repo / backend-lookup failure — before any runner spawned.
      await this.finalize(job.id, 'failed', { reason: 'provision_error', error: errText(err) });
    }
  }

  /** Apply every job the runner left in `applying`, once each. */
  async applyReady(): Promise<void> {
    let jobs: DevJob[];
    try {
      jobs = await this.deps.store.listJobs({ status: 'applying' });
    } catch (err) {
      this.log(`[dev-platform] listing applying jobs failed: ${errText(err)}`);
      return;
    }
    for (const job of jobs) {
      if (this.applying.has(job.id)) continue;
      this.applying.add(job.id);
      try {
        await this.applyJob(job.id);
      } catch (err) {
        // applyJob already finalized the job `failed`; this is the log path.
        this.log(`[dev-platform] apply(${job.id}) failed: ${errText(err)}`);
      } finally {
        this.applying.delete(job.id);
      }
    }
  }

  /** Commit the uploaded diff host-side and open the PR (spec §8). Also the
   *  route's `POST /jobs/:id/apply` retry entry, so it accepts `applying` OR a
   *  job that `failed` after a diff was uploaded. Success ⇒ `done` (+ pr_url);
   *  any failure ⇒ `failed` with the diff artifact RETAINED, then rethrows so the
   *  HTTP caller sees the error. */
  async applyJob(jobId: string): Promise<ApplyJobOutcome> {
    const job = await this.deps.store.getJob(jobId);
    if (!job) throw new DevJobWorkerError('devplatform.job_not_found', `no such job '${jobId}'`);

    const failedAfterDiff = job.status === 'failed' && Boolean(job.result?.diffArtifactId);
    if (job.status !== 'applying' && !failedAfterDiff) {
      throw new DevJobWorkerError('devplatform.apply_not_allowed', `cannot apply while job is '${job.status}'`);
    }

    try {
      const repo = await this.deps.repoStore.getRepo(job.repoId);
      if (!repo) throw new DevJobWorkerError('devplatform.repo_not_found', `job repo '${job.repoId}' not found`);

      const artifactId = job.result?.diffArtifactId;
      if (!artifactId) throw new DevJobWorkerError('devplatform.no_diff', 'job has no uploaded diff to apply');
      const artifact = await this.deps.store.getArtifact(artifactId);
      if (!artifact) {
        throw new DevJobWorkerError('devplatform.diff_missing', `diff artifact '${artifactId}' not found`);
      }

      const { diff, numstat } = splitDiffBundle(artifact.content);
      const branch = job.branch ?? defaultBranchName(job);
      const applied = await this.deps.applyService.apply({
        job: { id: job.id, branch, baseSha: job.baseSha ?? '' },
        repo: { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch },
        diff,
        numstat,
        pr: { title: prTitle(job), body: prBody(job, repo) },
        // The AUTHORITATIVE apply gate reads these (spec §6): the repo's operator
        // overrides, and the job's own tokens (see `jobTokensFor`).
        policyOverrides: repo.policyOverrides,
        jobTokens: jobTokensFor(job),
      });

      await this.finalize(job.id, 'done', {
        reason: 'applied',
        branch: applied.branch,
        prUrl: applied.prUrl,
      });
      return { prUrl: applied.prUrl };
    } catch (err) {
      // A `gate` verdict is NOT a failure — the diff policy needs a human. Open the
      // gate + park the job `waiting` (nothing applied, no PR) and return; do NOT
      // finalize `failed`, do NOT rethrow. Requires the wiring to have injected a
      // gate handler; without one, it falls through to the `failed` finalize.
      if (err instanceof DiffApplyError && err.code === 'policy_gate' && this.deps.policyGate && err.verdict) {
        const { gateId } = await this.deps.policyGate.onGate(job, err.verdict);
        this.log(`[dev-platform] apply(${job.id}) gated by diff policy → gate ${gateId} (job waiting)`);
        return { gated: true, gateId };
      }
      // A `deny` is final (no human override): persist the findings for the audit
      // trail, then fall through to the `failed` finalize below.
      if (err instanceof DiffApplyError && err.code === 'policy_deny' && this.deps.policyGate && err.verdict) {
        await this.deps.policyGate.onDeny(job, err.verdict);
      }
      // The diff artifact is never deleted here — `POST /jobs/:id/apply` can
      // retry against the same stored diff.
      await this.finalize(job.id, 'failed', { reason: 'apply_failed', error: errText(err) });
      throw err;
    }
  }

  /** Terminate a handle with the backend that owns its kind. A missing backend
   *  is logged, not thrown — finalize must not be blocked by it. */
  private async terminateHandle(handle: RunnerHandle): Promise<void> {
    const backend = this.backends.get(handle.backend);
    if (!backend) {
      this.log(`[dev-platform] no backend to terminate a '${handle.backend}' handle (${handle.id})`);
      return;
    }
    await backend.terminate(handle);
  }

  /** Resolve the still-active job a reaped handle belongs to. A reaped runner's
   *  handle id is its workspace/container id; the owning job carries it in
   *  `runner_handle`. An already-terminal job returns null (nothing to finalize),
   *  which is what makes a handle reaped on two consecutive ticks a no-op. */
  private async jobForHandle(handle: RunnerHandle): Promise<DevJob | null> {
    return this.deps.store.findActiveByHandleId(handle.id);
  }
}

// --- Local helpers ---------------------------------------------------------

function toRegistry(revokers: DevJobWorkerDeps['revokers']): CredentialRevokerRegistry {
  if (revokers instanceof CredentialRevokerRegistry) return revokers;
  const reg = new CredentialRevokerRegistry();
  for (const r of revokers ?? []) reg.register(r);
  return reg;
}

/**
 * Extra secret VALUES to scan the diff/PR-body for — beyond the prefix + entropy
 * rules. Deliberately EMPTY: the runner's real credentials (`djr_` bearer, `ghs_`
 * scoped App token, LLM-proxy token) all carry detectable prefixes and are caught
 * by scanForSecrets regardless of this list. The job id is PUBLIC (the platform
 * itself writes it into the PR body — `- Job: <id>`), and `runner_token_hash` is a
 * sha256 hash, not a usable credential; scanning for either would deny the
 * platform's own honest PR body as a "leak" (Forge-integration false positive).
 * A prefix-less secret nonce the server actually held would be added here.
 */
function jobTokensFor(_job: DevJob): string[] {
  return [];
}

/** The authoritative branch when a job was never pinned one — mirrors the
 *  `omadia/job-<id8>-<slug>` shape the spec pins host-side. */
function defaultBranchName(job: DevJob): string {
  const id8 = job.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'job';
  return `omadia/job-${id8}`;
}

function prTitle(job: DevJob): string {
  const first = job.brief.split('\n', 1)[0]?.trim() ?? '';
  const label = first.length > 0 ? first.slice(0, 72) : `${job.kind} job ${job.id.slice(0, 8)}`;
  return label;
}

function prBody(job: DevJob, repo: DevRepo): string {
  const lines = [
    `Automated change from the omadia dev platform (${job.kind}).`,
    '',
    `- Repository: ${repo.owner}/${repo.name}`,
    `- Job: ${job.id}`,
    ...(job.sourceRef ? [`- Source: ${job.sourceRef}`] : []),
  ];
  return lines.join('\n');
}

/** Human-readable error text. Coded errors (worker/backend refusals) are
 *  rendered `<code>: <message>` so the `devplatform.` code survives into
 *  `dev_jobs.error` and the logs, where incident triage greps for it. */
function errText(err: unknown): string {
  if (err instanceof DevJobWorkerError || err instanceof RunnerBackendError) {
    return `${err.code}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
