import type { Pool } from 'pg';
import type { JsonObject, JsonValue } from '@omadia/conductor-core';

export type RunStatus = 'running' | 'waiting' | 'completed' | 'failed';
export type TriggerKind = 'manual' | 'cron' | 'channel' | 'agent' | 'webhook' | 'workflow' | 'event';

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
  }): Promise<ConductorRun> {
    const r = await this.pool.query<RunRow>(
      `INSERT INTO conductor_runs
         (workflow_version_id, status, current_step_id, context, trigger_kind, trigger_source, is_dry_run)
       VALUES ($1, 'running', $2, $3::jsonb, $4, $5::jsonb, $6)
       RETURNING ${RUN_COLS}`,
      [
        input.workflowVersionId,
        input.entryStepId,
        JSON.stringify(input.context),
        input.triggerKind,
        input.triggerSource === undefined ? null : JSON.stringify(input.triggerSource),
        input.isDryRun ?? false,
      ],
    );
    return toRun(r.rows[0]!);
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
      await client.query(
        `UPDATE conductor_runs
            SET current_step_id = $2, context = $3::jsonb, status = $4,
                ended_at = CASE WHEN $5 THEN now() ELSE ended_at END
          WHERE id = $1`,
        [input.runId, input.nextStepId, JSON.stringify(input.context), input.status, ended],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async stepsForRun(runId: string): Promise<ConductorRunStep[]> {
    const r = await this.pool.query<StepRow>(
      `SELECT ${STEP_COLS} FROM conductor_run_steps WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return r.rows.map(toStep);
  }
}
