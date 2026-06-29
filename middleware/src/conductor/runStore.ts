import type { Pool } from 'pg';
import type { JsonObject, JsonValue } from '@omadia/conductor-core';

export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed';
export type TriggerKind = 'manual' | 'cron' | 'channel' | 'agent' | 'webhook' | 'workflow' | 'event';

/**
 * Thrown when a step/park write is fenced out because the run's lease (`claimed_by`) no
 * longer matches the driver's token — i.e. a resume worker has taken the run over. The
 * superseded driver catches this and stops, so a run is never driven by two owners at once.
 */
export class RunLeaseLostError extends Error {
  constructor(runId: string) {
    super(`run '${runId}' lease lost (claimed by another worker)`);
    this.name = 'RunLeaseLostError';
  }
}

export interface ConductorRun {
  id: string;
  workflowVersionId: string;
  status: RunStatus;
  currentStepId: string | null;
  context: JsonObject;
  triggerKind: TriggerKind;
  triggerSource: JsonValue | null;
  isDryRun: boolean;
  startedAt: Date;
  endedAt: Date | null;
}

export interface ConductorRunStep {
  id: string;
  runId: string;
  stepId: string;
  seq: number;
  actor: JsonValue | null;
  postconditionOutcome: string | null;
  transitionTaken: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

interface RunRow {
  id: string;
  workflow_version_id: string;
  status: RunStatus;
  current_step_id: string | null;
  context: JsonObject;
  trigger_kind: TriggerKind;
  trigger_source: JsonValue | null;
  is_dry_run: boolean;
  started_at: Date;
  ended_at: Date | null;
}

interface StepRow {
  id: string;
  run_id: string;
  step_id: string;
  seq: number;
  actor: JsonValue | null;
  postcondition_outcome: string | null;
  transition_taken: string | null;
  started_at: Date;
  ended_at: Date | null;
}

function toRun(r: RunRow): ConductorRun {
  return {
    id: r.id,
    workflowVersionId: r.workflow_version_id,
    status: r.status,
    currentStepId: r.current_step_id,
    context: r.context,
    triggerKind: r.trigger_kind,
    triggerSource: r.trigger_source,
    isDryRun: r.is_dry_run,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function toStep(r: StepRow): ConductorRunStep {
  return {
    id: r.id,
    runId: r.run_id,
    stepId: r.step_id,
    seq: r.seq,
    actor: r.actor,
    postconditionOutcome: r.postcondition_outcome,
    transitionTaken: r.transition_taken,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

const RUN_COLS = `id, workflow_version_id, status, current_step_id, context, trigger_kind, trigger_source, is_dry_run, started_at, ended_at`;
const STEP_COLS = `id, run_id, step_id, seq, actor, postcondition_outcome, transition_taken, started_at, ended_at`;

/** Persistence for runs + their durable per-step record (resume checkpoint + audit trace). */
export class ConductorRunStore {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    workflowVersionId: string;
    entryStepId: string;
    context: JsonObject;
    triggerKind: TriggerKind;
    triggerSource?: JsonValue | null;
    isDryRun?: boolean;
    /** Lease token of the in-process driver — fences this run's step writes (see RunLeaseLostError). */
    claimedBy: string;
  }): Promise<ConductorRun> {
    const r = await this.pool.query<RunRow>(
      // claimed_by/claimed_at set now: this run is driven in-process immediately, so the
      // resume worker must neither treat it as orphaned nor steal it during its first step.
      `INSERT INTO conductor_runs
         (workflow_version_id, status, current_step_id, context, trigger_kind, trigger_source, is_dry_run, claimed_by, claimed_at)
       VALUES ($1, 'running', $2, $3::jsonb, $4, $5::jsonb, $6, $7, now())
       RETURNING ${RUN_COLS}`,
      [
        input.workflowVersionId,
        input.entryStepId,
        JSON.stringify(input.context),
        input.triggerKind,
        input.triggerSource === undefined ? null : JSON.stringify(input.triggerSource),
        input.isDryRun ?? false,
        input.claimedBy,
      ],
    );
    return toRun(r.rows[0]!);
  }

  /**
   * Take over a run's lease (used by the human-response / deadline paths, which resume a
   * 'waiting' run that no driver currently owns). Unconditional: the resuming caller becomes
   * the authoritative owner; its subsequent step writes are then fenced on this token.
   */
  async acquireLease(runId: string, claimedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE conductor_runs SET claimed_by = $2, claimed_at = now() WHERE id = $1`,
      [runId, claimedBy],
    );
  }

  async get(runId: string): Promise<ConductorRun | null> {
    const r = await this.pool.query<RunRow>(`SELECT ${RUN_COLS} FROM conductor_runs WHERE id = $1`, [runId]);
    return r.rows[0] ? toRun(r.rows[0]) : null;
  }

  async listForVersion(workflowVersionId: string, limit = 50): Promise<ConductorRun[]> {
    const safe = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const r = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLS} FROM conductor_runs WHERE workflow_version_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [workflowVersionId, safe],
    );
    return r.rows.map(toRun);
  }

  /** Persist a completed step (the resume checkpoint + audit record) and the run's
   *  advanced state in one transaction (FR-004 — durable before the next step begins). */
  async recordStepAndAdvance(input: {
    runId: string;
    seq: number;
    stepId: string;
    actor: JsonValue | null;
    postconditionOutcome: string | null;
    transitionTaken: string | null;
    nextStepId: string | null;
    context: JsonObject;
    status: RunStatus;
    /** Driver's lease token — the run UPDATE is fenced on it (throws RunLeaseLostError on mismatch). */
    claimedBy: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO conductor_run_steps
           (run_id, step_id, seq, actor, postcondition_outcome, transition_taken, ended_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())`,
        [
          input.runId,
          input.stepId,
          input.seq,
          input.actor === null ? null : JSON.stringify(input.actor),
          input.postconditionOutcome,
          input.transitionTaken,
        ],
      );
      const ended = input.status === 'completed' || input.status === 'failed';
      const upd = await client.query(
        // Fence on claimed_by: if a resume worker has taken this run over, the lease no longer
        // matches and 0 rows update — we roll back (the step row too) and signal RunLeaseLostError.
        // While the run stays 'running', refresh claimed_at — the per-step heartbeat the resume
        // worker uses to tell a live drive from an orphaned one.
        `UPDATE conductor_runs
            SET current_step_id = $2, context = $3::jsonb, status = $4,
                ended_at = CASE WHEN $5 THEN now() ELSE ended_at END,
                claimed_at = CASE WHEN $4 = 'running' THEN now() ELSE claimed_at END
          WHERE id = $1 AND claimed_by = $6`,
        [input.runId, input.nextStepId, JSON.stringify(input.context), input.status, ended, input.claimedBy],
      );
      if ((upd.rowCount ?? 0) === 0) throw new RunLeaseLostError(input.runId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Park a run as `waiting` at a step (a durable human await is open) without a step record. */
  async park(runId: string, stepId: string, context: JsonObject, claimedBy: string): Promise<void> {
    const r = await this.pool.query(
      `UPDATE conductor_runs SET status = 'waiting', current_step_id = $2, context = $3::jsonb
        WHERE id = $1 AND claimed_by = $4`,
      [runId, stepId, JSON.stringify(context), claimedBy],
    );
    if ((r.rowCount ?? 0) === 0) throw new RunLeaseLostError(runId);
  }

  /**
   * Atomically claim up to `limit` 'running' runs whose heartbeat (`claimed_at`) is
   * stale — i.e. older than `staleMs`, or never set (pre-migration rows). These are
   * runs orphaned by a process restart. `FOR UPDATE SKIP LOCKED` + the conditional
   * UPDATE make the claim exclusive, so concurrent workers/replicas never both grab
   * the same run. Dry-run rows are never resumed (they have no durable effects).
   */
  async claimResumableRuns(claimerId: string, staleMs: number, limit: number): Promise<ConductorRun[]> {
    const safe = Math.min(Math.max(1, Math.trunc(limit)), 200);
    const r = await this.pool.query<RunRow>(
      `UPDATE conductor_runs
          SET claimed_by = $1, claimed_at = now()
        WHERE id IN (
          SELECT id FROM conductor_runs
           WHERE status = 'running'
             AND is_dry_run = false
             AND (claimed_at IS NULL OR claimed_at < now() - (interval '1 millisecond' * $2))
           ORDER BY started_at ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${RUN_COLS}`,
      [claimerId, staleMs, safe],
    );
    return r.rows.map(toRun);
  }

  async stepsForRun(runId: string): Promise<ConductorRunStep[]> {
    const r = await this.pool.query<StepRow>(
      `SELECT ${STEP_COLS} FROM conductor_run_steps WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return r.rows.map(toStep);
  }
}
