/**
 * Epic #470 W0 — DevJobStore: the durable job spine (spec §4).
 *
 * Queue state lives in Postgres from day one — deliberately NOT the builder's
 * in-memory `BuildQueue` — so a restart never orphans a job. Claim/lease mirrors
 * `conductor/runStore.ts`: `claimNextQueued` grabs one queued row with `FOR
 * UPDATE SKIP LOCKED`, stamping a `randomUUID()` lease into `claimed_by`; every
 * subsequent WORKER write is fenced `WHERE claimed_by = <lease>` (0 rows ⇒
 * `DevJobLeaseLostError`, cf. `RunLeaseLostError`). Terminal transitions are NOT
 * here: `finishTerminal` is brand-gated so `finalizeDevJob.ts` is the one choke
 * point. Repo CRUD lives in `devRepoStore.ts` (file-size split).
 */

import type { Pool } from 'pg';

import * as artifacts from './devJobArtifactStore.js';
import type { DevJobEventBus } from './devJobEventBus.js';
import * as seams from './devJobWorkerSeams.js';
import { hashRunnerToken, verifyRunnerToken as verifyToken } from './jobToken.js';
import { asObj, iso, isoN, num, str, strN, type Row } from './pgMappers.js';
import {
  isDevJobEventType,
  isTerminalDevJobStatus,
  type DevJob,
  type DevJobArtifact,
  type DevJobEvent,
  type DevJobEventType,
  type DevJobResult,
  type DevJobPhase,
  type DevJobStatus,
  type NewDevJob,
  type RunnerHandle,
} from './types.js';

/**
 * Thrown when a lease-fenced worker write updates 0 rows — the job's
 * `claimed_by` no longer matches this worker's lease (another worker claimed
 * it, or it was finalized). The worker catches this and stops. Mirrors
 * conductor's `RunLeaseLostError`.
 */
export class DevJobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`dev job '${jobId}' lease lost (claimed by another worker or already terminal)`);
    this.name = 'DevJobLeaseLostError';
  }
}

/**
 * Capability brand for the terminal write. `finishTerminal` refuses to run
 * without it, and only `finalizeDevJob.ts` imports it — so nothing else in the
 * codebase can mark a job terminal, enforcing the single choke point at runtime
 * (stronger than a compile-time `private`, which a sibling module could not
 * call at all).
 */
export const TERMINAL_FINISH_BRAND: unique symbol = Symbol('devplatform.terminalFinish');

/** Host/control-plane event provision namespace (spec §9). Runner sessions use
 *  provision ≥ 1 (migration default); host-emitted events (finalize's status
 *  event) use 0 so they never collide with a runner's `seq` space. */
export const HOST_EVENT_PROVISION = 0;

/** One event as posted by the runner (spec §4 POST /events). `type` is
 *  validated here — the DB no longer constrains it (0022). */
export interface RunnerEventInput {
  seq: number;
  type: DevJobEventType;
  ts?: string | null;
  payload?: Record<string, unknown>;
}

/** Fields a terminal transition may set alongside the status flip. */
export interface TerminalPatch {
  error?: string | null;
  result?: DevJobResult | null;
  branch?: string | null;
  prUrl?: string | null;
}

/** Shared with `devJobWorkerSeams.ts` (worker-seam bodies live there for the
 *  500-line rule); not part of the public store API. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TERMINAL_SET_SQL = `'done','failed','cancelled','stalled','budget_exceeded'`;
export const ACTIVE_SET_SQL = `'provisioning','running','applying'`;

export const JOB_COLS =
  `id, repo_id, kind, brief, source, source_ref, base_sha, backend, agent_kind, auth_mode, ` +
  `provision, phase, pipeline_mode, review_attempt, review_fingerprint, retry_of, ` +
  `status, claimed_by, claimed_at, last_heartbeat_at, runner_handle, ` +
  `runner_token_hash, branch, pr_url, result, error, tokens_in, tokens_out, cost_usd, ` +
  `created_by, created_at, started_at, ended_at, updated_at`;
const EVENT_COLS = `id, job_id, provision, seq, type, ts, payload`;

export function toJob(r: Row): DevJob {
  return {
    id: str(r['id']),
    repoId: str(r['repo_id']),
    kind: str(r['kind']) as DevJob['kind'],
    brief: str(r['brief']),
    source: str(r['source']) as DevJob['source'],
    sourceRef: strN(r['source_ref']),
    baseSha: strN(r['base_sha']),
    backend: str(r['backend']) as DevJob['backend'],
    agentKind: str(r['agent_kind']),
    authMode: str(r['auth_mode']) as DevJob['authMode'],
    provision: num(r['provision']),
    phase: str(r['phase']) as DevJob['phase'],
    pipelineMode: (str(r['pipeline_mode']) as DevJob['pipelineMode']) || 'gated',
    reviewAttempt: num(r['review_attempt']),
    reviewFingerprint: strN(r['review_fingerprint']),
    retryOf: strN(r['retry_of']),
    status: str(r['status']) as DevJobStatus,
    claimedBy: strN(r['claimed_by']),
    claimedAt: isoN(r['claimed_at']),
    lastHeartbeatAt: isoN(r['last_heartbeat_at']),
    runnerHandle: asObj<RunnerHandle | null>(r['runner_handle'], null),
    runnerTokenHash: strN(r['runner_token_hash']),
    branch: strN(r['branch']),
    prUrl: strN(r['pr_url']),
    result: asObj<DevJobResult | null>(r['result'], null),
    error: strN(r['error']),
    tokensIn: num(r['tokens_in']),
    tokensOut: num(r['tokens_out']),
    costUsd: num(r['cost_usd']),
    createdBy: str(r['created_by']),
    createdAt: iso(r['created_at']),
    startedAt: isoN(r['started_at']),
    endedAt: isoN(r['ended_at']),
    updatedAt: iso(r['updated_at']),
  };
}

function toEvent(r: Row): DevJobEvent {
  return {
    id: num(r['id']),
    jobId: str(r['job_id']),
    provision: num(r['provision']),
    seq: num(r['seq']),
    type: str(r['type']) as DevJobEventType,
    ts: iso(r['ts']),
    payload: asObj(r['payload'], {}),
  };
}

export interface DevJobStoreOptions {
  /** Live tail for SSE. When present, appended events are published to it. */
  eventBus?: DevJobEventBus;
}

export interface ListJobsFilter {
  repoId?: string;
  status?: DevJobStatus;
  limit?: number;
}

export class DevJobStore {
  private readonly pool: Pool;
  private readonly bus?: DevJobEventBus;

  constructor(pool: Pool, opts: DevJobStoreOptions = {}) {
    this.pool = pool;
    this.bus = opts.eventBus;
  }

  async createJob(input: NewDevJob & { runnerTokenHash: string }): Promise<DevJob> {
    const r = await this.pool.query<Row>(
      `INSERT INTO dev_jobs
         (repo_id, kind, brief, source, source_ref, base_sha, backend, agent_kind, auth_mode,
          provision, phase, branch, runner_token_hash, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${JOB_COLS}`,
      [
        input.repoId,
        input.kind,
        input.brief,
        input.source,
        input.sourceRef ?? null,
        input.baseSha ?? null,
        input.backend,
        input.agentKind ?? 'claude-cli',
        input.authMode ?? 'api_key',
        input.provision ?? 1,
        input.phase ?? 'implement',
        input.branch ?? null,
        input.runnerTokenHash,
        input.createdBy,
      ],
    );
    return toJob(r.rows[0]!);
  }

  async getJob(id: string): Promise<DevJob | null> {
    const r = await this.pool.query<Row>(`SELECT ${JOB_COLS} FROM dev_jobs WHERE id = $1`, [id]);
    return r.rows[0] ? toJob(r.rows[0]) : null;
  }

  async listJobs(filter: ListJobsFilter = {}): Promise<DevJob[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.repoId) {
      params.push(filter.repoId);
      where.push(`repo_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 100)), 500);
    params.push(limit);
    const r = await this.pool.query<Row>(
      `SELECT ${JOB_COLS} FROM dev_jobs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toJob);
  }

  /**
   * Atomically claim the oldest queued job with `FOR UPDATE SKIP LOCKED`, so two
   * concurrent workers never grab the same row (spec §4). `claimedBy` is the
   * worker's `randomUUID()` lease — a non-UUID is rejected loudly, not surfaced
   * as an opaque Postgres `22P02` from the `uuid` column cast.
   */
  async claimNextQueued(claimedBy: string): Promise<DevJob | null> {
    if (!UUID_RE.test(claimedBy)) {
      throw new TypeError(`claimNextQueued: claimedBy must be a UUID (got '${claimedBy}')`);
    }
    const r = await this.pool.query<Row>(
      `UPDATE dev_jobs
          SET status = 'provisioning', claimed_by = $1, claimed_at = now(), started_at = now(),
              updated_at = now()
        WHERE id = (
          SELECT id FROM dev_jobs WHERE status = 'queued'
           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING ${JOB_COLS}`,
      [claimedBy],
    );
    return r.rows[0] ? toJob(r.rows[0]) : null;
  }

  /**
   * Hand a claimed job back to the queue, un-started.
   *
   * A backend that answers "at capacity" has not failed the job — it has
   * declined to start it *now*. Finalizing such a job as `failed` would turn a
   * transient scheduling condition into a permanent, user-visible error, so the
   * worker calls this instead and the next poll re-claims the row.
   *
   * Lease-fenced and status-guarded: only the worker that still owns the claim,
   * and only while the job is still `provisioning` (nothing was spawned, no
   * runner handle was ever attached), can rewind it. 0 rows ⇒ the lease moved
   * on and the caller must not touch the row.
   */
  async releaseClaim(jobId: string, claimedBy: string): Promise<boolean> {
    if (!UUID_RE.test(claimedBy)) {
      throw new TypeError(`releaseClaim: claimedBy must be a UUID (got '${claimedBy}')`);
    }
    const r = await this.pool.query(
      `UPDATE dev_jobs
          SET status = 'queued', claimed_by = NULL, claimed_at = NULL, started_at = NULL,
              updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status = 'provisioning'
          AND runner_handle IS NULL`,
      [jobId, claimedBy],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Bump liveness without writing an event.
   *
   * `appendEvents` bumps `last_heartbeat_at` too, but it returns early on an
   * empty batch — and an agent that thinks for two minutes without emitting a
   * tool call produces exactly that. Without a standalone touch, `findStalled`
   * would reap a perfectly healthy job. Status-guarded: a terminal job stays
   * terminal, so a half-dead runner cannot resurrect itself by heartbeating.
   */
  async touchHeartbeat(jobId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE dev_jobs SET last_heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('provisioning', 'running', 'applying')`,
      [jobId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Flip provisioning → running when the runner fetches its spec (spec §4). Runner-
   *  driven (job-token auth), so status-guarded rather than lease-fenced. */
  async markRunning(jobId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE dev_jobs SET status = 'running', updated_at = now()
        WHERE id = $1 AND status = 'provisioning'`,
      [jobId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * W2: advance a job's phase, fenced on the phase it is LEAVING. A stale runner
   * (one that ran a phase the job already moved past) presents the old `from`,
   * matches 0 rows, and the caller returns 409 — its result is discarded. The
   * status-guard keeps a terminal job terminal.
   */
  async advancePhase(jobId: string, from: DevJobPhase, to: DevJobPhase): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE dev_jobs SET phase = $3, updated_at = now()
        WHERE id = $1 AND phase = $2 AND status NOT IN (${TERMINAL_SET_SQL})`,
      [jobId, from, to],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * W2: re-queue a gate-parked job for its next provision (the implement phase).
   * The runner has exited (park); the claim loop re-provisions at the pinned
   * base_sha once the gate resolves. Sets phase, clears the lease, status→queued.
   *
   * FENCED on `phase = 'await_human'` (Forge #4): only a job that is genuinely
   * parked at the gate may be re-queued. Without the fence this would re-queue ANY
   * non-terminal job, and — since a self-heal re-drive can call it more than once
   * — the fence is also what makes the re-drive idempotent: the second call, on a
   * job already moved to `implement`/`queued`, matches 0 rows and is a no-op.
   */
  async requeueAtPhase(jobId: string, phase: DevJobPhase): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE dev_jobs
          SET phase = $2, status = 'queued', claimed_by = NULL, claimed_at = NULL,
              runner_handle = NULL, provision = provision + 1, updated_at = now()
        WHERE id = $1 AND phase = 'await_human' AND status NOT IN (${TERMINAL_SET_SQL})`,
      [jobId, phase],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * W2: park a job at the human gate. The runner has exited; the job holds at
   * `await_human` with status `waiting` and no lease, so the claim loop leaves it
   * alone until the gate resolves and `requeueAtPhase` re-queues it. Phase-fenced
   * on `await_human` so only a job the engine just advanced there parks.
   */
  async parkForGate(jobId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE dev_jobs
          SET status = 'waiting', claimed_by = NULL, claimed_at = NULL,
              runner_handle = NULL, updated_at = now()
        WHERE id = $1 AND phase = 'await_human' AND status NOT IN (${TERMINAL_SET_SQL})`,
      [jobId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * W2: append a delimited section to the job's brief, at most once (spec §5,
   * "answers append to the brief"). The `marker` is a substring the caller
   * guarantees is present in `section`; the append is skipped when the brief
   * already contains it, so a gate self-heal re-drive (which calls the approve/
   * reject side effect more than once) never double-appends. Terminal jobs are
   * left untouched. Returns true iff this call actually wrote the section.
   */
  async appendToBrief(jobId: string, marker: string, section: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE dev_jobs SET brief = brief || $3, updated_at = now()
        WHERE id = $1 AND position($2 in brief) = 0 AND status NOT IN (${TERMINAL_SET_SQL})`,
      [jobId, marker, section],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** W2: record the review loop's attempt counter + fingerprint (same provision). */
  async setReviewState(jobId: string, attempt: number, fingerprint: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE dev_jobs SET review_attempt = $2, review_fingerprint = $3, updated_at = now()
        WHERE id = $1 AND status NOT IN (${TERMINAL_SET_SQL})`,
      [jobId, attempt, fingerprint],
    );
  }

  /** Attach the backend handle. A WORKER write — lease-fenced; 0 rows ⇒ lease lost. */
  async setRunnerHandle(jobId: string, claimedBy: string, handle: RunnerHandle): Promise<void> {
    const r = await this.pool.query(
      `UPDATE dev_jobs SET runner_handle = $3::jsonb, last_heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status NOT IN (${TERMINAL_SET_SQL})`,
      [jobId, claimedBy, JSON.stringify(handle)],
    );
    if ((r.rowCount ?? 0) === 0) throw new DevJobLeaseLostError(jobId);
  }

  /**
   * Record the runner's reported result + usage. `diff_ready` moves the job to
   * `applying` (the WORKER then applies + opens the PR); other outcomes only
   * persist the payload — the terminal flip goes through `finalizeDevJob`, never
   * here. Status-guarded (skips an already-terminal job); runner-driven, so not
   * lease-fenced.
   */
  async recordResult(jobId: string, result: DevJobResult): Promise<void> {
    const u = result.usage ?? {};
    const nextStatus = result.outcome === 'diff_ready' ? 'applying' : null;
    await this.pool.query(
      `UPDATE dev_jobs
          SET result = $2::jsonb,
              status = COALESCE($3, status),
              tokens_in = $4, tokens_out = $5, cost_usd = $6,
              error = COALESCE($7, error), updated_at = now()
        WHERE id = $1 AND status NOT IN (${TERMINAL_SET_SQL})`,
      [
        jobId,
        JSON.stringify(result),
        nextStatus,
        u.tokensIn ?? 0,
        u.tokensOut ?? 0,
        u.costUsd ?? 0,
        result.error ?? null,
      ],
    );
  }

  // --- events --------------------------------------------------------------
  /**
   * Append a batch of runner events. Idempotent per `(job_id, provision, seq)`
   * via `ON CONFLICT DO NOTHING` (a retried batch is a safe no-op); the SAME
   * `seq` under a DIFFERENT provision is accepted — that is what `provision` is
   * for. Bumps `last_heartbeat_at`, publishes each newly stored event to the
   * live bus, returns the count actually inserted.
   */
  async appendEvents(jobId: string, provision: number, events: RunnerEventInput[]): Promise<number> {
    if (events.length === 0) return 0;
    const params: unknown[] = [jobId, provision];
    const tuples: string[] = [];
    for (const e of events) {
      if (!Number.isInteger(e.seq) || e.seq < 0) {
        throw new TypeError(`appendEvents: seq must be a non-negative integer (got ${String(e.seq)})`);
      }
      if (!isDevJobEventType(e.type)) {
        throw new TypeError(`appendEvents: invalid event type '${String(e.type)}'`);
      }
      const b = params.length + 1;
      params.push(e.seq, e.type, e.ts ?? null, JSON.stringify(e.payload ?? {}));
      tuples.push(`($1, $2, $${b}, $${b + 1}, COALESCE($${b + 2}::timestamptz, now()), $${b + 3}::jsonb)`);
    }
    const res = await this.pool.query<Row>(
      `INSERT INTO dev_job_events (job_id, provision, seq, type, ts, payload)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (job_id, provision, seq) DO NOTHING
       RETURNING ${EVENT_COLS}`,
      params,
    );
    // Heartbeat only while the job can still receive events (never resurrect a
    // terminal job's timestamps).
    await this.pool.query(
      `UPDATE dev_jobs SET last_heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND status NOT IN (${TERMINAL_SET_SQL})`,
      [jobId],
    );
    for (const row of res.rows) this.bus?.publish(jobId, toEvent(row));
    return res.rows.length;
  }

  /**
   * Append a host/control-plane event (provision {@link HOST_EVENT_PROVISION}),
   * assigning the next `seq` in that namespace. Used by `finalizeDevJob` for the
   * terminal `status` event, which has no runner `seq`. Retries on the rare
   * concurrent-seq collision.
   */
  async appendHostEvent(
    jobId: string,
    type: DevJobEventType,
    payload: Record<string, unknown> = {},
  ): Promise<DevJobEvent | null> {
    if (!isDevJobEventType(type)) {
      throw new TypeError(`appendHostEvent: invalid event type '${String(type)}'`);
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.pool.query<Row>(
        `INSERT INTO dev_job_events (job_id, provision, seq, type, payload)
         VALUES ($1, ${HOST_EVENT_PROVISION},
                 (SELECT COALESCE(MAX(seq), -1) + 1 FROM dev_job_events
                   WHERE job_id = $1 AND provision = ${HOST_EVENT_PROVISION}),
                 $2, $3::jsonb)
         ON CONFLICT (job_id, provision, seq) DO NOTHING
         RETURNING ${EVENT_COLS}`,
        [jobId, type, JSON.stringify(payload)],
      );
      if (res.rows[0]) {
        const ev = toEvent(res.rows[0]);
        this.bus?.publish(jobId, ev);
        return ev;
      }
    }
    return null;
  }

  /** Events ordered by the IDENTITY `id` — the sole ordering key, monotonic
   *  across provisions (NEVER `seq`, which only orders within one provision). */
  async listEvents(jobId: string, afterId?: number, limit = 500): Promise<DevJobEvent[]> {
    const safe = Math.min(Math.max(1, Math.trunc(limit)), 2000);
    const r = await this.pool.query<Row>(
      `SELECT ${EVENT_COLS} FROM dev_job_events
        WHERE job_id = $1 AND ($2::bigint IS NULL OR id > $2)
        ORDER BY id ASC LIMIT $3`,
      [jobId, afterId ?? null, safe],
    );
    return r.rows.map(toEvent);
  }

  // --- artifacts -----------------------------------------------------------
  // --- artifacts (delegated to devJobArtifactStore.ts, 500-line rule) -------
  async artifactBelongsToJob(jobId: string, artifactId: string): Promise<boolean> {
    return artifacts.artifactBelongsToJob(this.pool, jobId, artifactId);
  }

  async addArtifact(
    jobId: string,
    kind: string,
    content: string,
    meta: Record<string, unknown> = {},
  ): Promise<string> {
    return artifacts.addArtifact(this.pool, jobId, kind, content, meta);
  }

  async getArtifact(id: string): Promise<DevJobArtifact | null> {
    return artifacts.getArtifact(this.pool, id);
  }

  async listArtifacts(jobId: string): Promise<DevJobArtifact[]> {
    return artifacts.listArtifacts(this.pool, jobId);
  }

  /** W2: the latest artifact of a kind — used to pin the plan at gate open. */
  async getLatestArtifact(jobId: string, kind: string): Promise<DevJobArtifact | null> {
    return artifacts.getLatestArtifact(this.pool, jobId, kind);
  }

  // --- tokens --------------------------------------------------------------
  /** sha256 + timing-safe check of a presented runner token against the stored
   *  hash. Unknown job ⇒ false. */
  async verifyRunnerToken(jobId: string, token: string): Promise<boolean> {
    const r = await this.pool.query<Row>(
      `SELECT runner_token_hash FROM dev_jobs WHERE id = $1`,
      [jobId],
    );
    if (!r.rows[0]) return false;
    return verifyToken(token, strN(r.rows[0]['runner_token_hash']));
  }

  /** Resolve a job from its runner bearer alone — the LLM proxy (spec §6b) sees
   *  only `Authorization: Bearer <djr_…>` and no jobId.
   *
   *  The indexed sha256 equality is used only to FIND the candidate row; the
   *  bearer is then VERIFIED against the stored hash with `crypto.timingSafeEqual`
   *  (the same constant-time pattern as {@link verifyRunnerToken}), so the check
   *  cannot be turned into a timing oracle.
   *
   *  Response-shape decision (documented): a TERMINAL job returns `null`, exactly
   *  like an unknown token. The LLM proxy therefore answers 401 for both, so a
   *  holder of a stale (now-terminal) token cannot use the 401-vs-410 distinction
   *  as a valid-token / job-state oracle. The proxy's own terminal→410 branch
   *  remains as defence-in-depth for any caller that surfaces a terminal job by
   *  other means. */
  async resolveJobByToken(token: string): Promise<Pick<DevJob, 'id' | 'status' | 'agentKind'> | null> {
    if (typeof token !== 'string' || token.length === 0) return null;
    const r = await this.pool.query<Row>(
      `SELECT id, status, agent_kind, runner_token_hash FROM dev_jobs WHERE runner_token_hash = $1`,
      [hashRunnerToken(token)],
    );
    const row = r.rows[0];
    if (!row) return null;
    // Constant-time verify (defends against a timing oracle even though the
    // indexed lookup already matched on the hash).
    if (!verifyToken(token, strN(row['runner_token_hash']))) return null;
    const status = str(row['status']) as DevJobStatus;
    if (isTerminalDevJobStatus(status)) return null;
    return { id: str(row['id']), status, agentKind: str(row['agent_kind']) };
  }

  /** Atomic per-job usage increment (spec §6b/§ W4). One statement so a
   *  concurrent read never sees a half-applied bump; W4 will add the budget
   *  enforcement onto this same UPDATE. */
  async addJobUsage(jobId: string, tokensIn: number, tokensOut: number): Promise<void> {
    await this.pool.query(
      `UPDATE dev_jobs SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3, updated_at = now()
        WHERE id = $1`,
      [jobId, Math.max(0, Math.trunc(tokensIn)), Math.max(0, Math.trunc(tokensOut))],
    );
  }

  // --- reaper / enforcement reads (worker calls finalizeDevJob on these) ----
  /** Active jobs whose last sign of life is older than `cutoff` — stalled
   *  candidates for the worker/reaper. */
  async findStalled(cutoff: Date): Promise<DevJob[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${JOB_COLS} FROM dev_jobs
        WHERE status IN (${ACTIVE_SET_SQL})
          AND COALESCE(last_heartbeat_at, started_at, claimed_at) < $1`,
      [cutoff],
    );
    return r.rows.map(toJob);
  }

  /** Active jobs started before `startedBefore` — over their wall-clock budget. */
  async findOverWallClock(startedBefore: Date): Promise<DevJob[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${JOB_COLS} FROM dev_jobs
        WHERE status IN (${ACTIVE_SET_SQL}) AND started_at IS NOT NULL AND started_at < $1`,
      [startedBefore],
    );
    return r.rows.map(toJob);
  }

  // --- worker seams (spec §4) — bodies in devJobWorkerSeams.ts (500-line rule) -
  /** Jobs occupying a runner slot; the worker's concurrency gate. */
  countActiveJobs(): Promise<number> {
    return seams.countActiveJobs(this.pool);
  }

  /** Still-active (provisioning/running) job for a handle id — excludes `applying`. */
  findActiveByHandleId(handleId: string): Promise<DevJob | null> {
    return seams.findActiveByHandleId(this.pool, handleId);
  }

  /** Mint the one-time runner token + pin branch/base_sha (lease-fenced). */
  prepareProvision(job: DevJob, lease: string, baseSha?: string | null): Promise<{ token: string; job: DevJob }> {
    return seams.prepareProvision(this.pool, job, lease, baseSha);
  }

  // --- terminal transition (finalizeDevJob only) ---------------------------
  /**
   * Flip a job to a terminal status. Brand-gated: the caller must present
   * {@link TERMINAL_FINISH_BRAND}, which in practice only `finalizeDevJob.ts`
   * imports. Be precise about what that buys — the brand is an exported symbol,
   * so a determined module could import it and call this directly. It prevents
   * an *accidental* terminal write, not a deliberate one. The invariant that
   * `finalizeDevJob` is the only terminal path is upheld by review, and the
   * brand makes a violation loud rather than silent. If a later wave needs the
   * stronger guarantee, move this method into `finalizeDevJob.ts`.
   * Idempotent: if the job is already terminal (or absent) the status-guarded
   * UPDATE touches 0 rows and the existing row is returned unchanged, so a
   * double-finalize is a no-op, not an error. NOT lease-fenced: cancel routes
   * and the reaper legitimately finalize jobs they do not lease.
   */
  async finishTerminal(
    brand: typeof TERMINAL_FINISH_BRAND,
    jobId: string,
    status: DevJobStatus,
    patch: TerminalPatch = {},
  ): Promise<DevJob | null> {
    if (brand !== TERMINAL_FINISH_BRAND) {
      throw new Error('devplatform: finishTerminal() is reserved for finalizeDevJob()');
    }
    if (!isTerminalDevJobStatus(status)) {
      throw new TypeError(`devplatform: '${status}' is not a terminal status`);
    }
    const r = await this.pool.query<Row>(
      `UPDATE dev_jobs
          SET status = $2,
              error = COALESCE($3, error),
              result = COALESCE($4::jsonb, result),
              branch = COALESCE($5, branch),
              pr_url = COALESCE($6, pr_url),
              ended_at = now(), updated_at = now()
        WHERE id = $1 AND status NOT IN (${TERMINAL_SET_SQL})
        RETURNING ${JOB_COLS}`,
      [
        jobId,
        status,
        patch.error ?? null,
        patch.result ? JSON.stringify(patch.result) : null,
        patch.branch ?? null,
        patch.prUrl ?? null,
      ],
    );
    if (r.rows[0]) return toJob(r.rows[0]);
    // Already terminal or absent — idempotent no-op, return existing state.
    return this.getJob(jobId);
  }
}
