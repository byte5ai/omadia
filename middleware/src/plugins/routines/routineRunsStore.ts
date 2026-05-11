import type { Pool } from 'pg';

import type { RoutineRunStatus } from './routineStore.js';

export type RoutineRunTrigger = 'cron' | 'catchup' | 'manual';

export interface RoutineRun {
  id: string;
  routineId: string;
  tenant: string;
  userId: string;
  trigger: RoutineRunTrigger;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  status: RoutineRunStatus;
  errorMessage: string | null;
  prompt: string;
  answer: string | null;
  iterations: number | null;
  toolCalls: number | null;
  /**
   * Full agentic trace produced by `Orchestrator.runTurn`. Stored as
   * opaque JSONB so the store layer doesn't have to track every field
   * the channel-sdk evolves over time. The Operator-UI viewer renders
   * this with a generic JSON-tree component.
   */
  runTrace: unknown | null;
}

export interface InsertRoutineRunInput {
  routineId: string;
  tenant: string;
  userId: string;
  trigger: RoutineRunTrigger;
  startedAt: Date;
  finishedAt: Date;
  status: RoutineRunStatus;
  errorMessage?: string | null;
  prompt: string;
  answer?: string | null;
  iterations?: number | null;
  toolCalls?: number | null;
  runTrace?: unknown;
}

export interface RoutineRunsStoreOptions {
  pool: Pool;
  log?: (msg: string) => void;
}

interface RoutineRunRow {
  id: string;
  routine_id: string;
  tenant: string;
  user_id: string;
  trigger: RoutineRunTrigger;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  status: RoutineRunStatus;
  error_message: string | null;
  prompt: string;
  answer: string | null;
  iterations: number | null;
  tool_calls: number | null;
  run_trace: unknown | null;
}

const SELECT_COLUMNS = `
  id, routine_id, tenant, user_id, trigger,
  started_at, finished_at, duration_ms, status, error_message,
  prompt, answer, iterations, tool_calls, run_trace
`;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function rowToRun(row: RoutineRunRow): RoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    tenant: row.tenant,
    userId: row.user_id,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    status: row.status,
    errorMessage: row.error_message,
    prompt: row.prompt,
    answer: row.answer,
    iterations: row.iterations,
    toolCalls: row.tool_calls,
    runTrace: row.run_trace,
  };
}

/**
 * Per-run history with full agentic trace. Append-only: one row per
 * scheduled or manual trigger. Read by the Operator-UI to render the
 * per-routine run list and the single-run detail page (call-stack viewer).
 *
 * Failure model:
 *   - insert is fire-and-forget from the runner's perspective: a failing
 *     telemetry write logs but never aborts the run (parity with
 *     `RoutineStore.recordRun`).
 *   - read paths bubble pg errors up so callers can decide.
 */
export class RoutineRunsStore {
  private readonly pool: Pool;
  private readonly log: (msg: string) => void;

  constructor(opts: RoutineRunsStoreOptions) {
    this.pool = opts.pool;
    this.log =
      opts.log ??
      ((msg: string): void => {
        console.error(msg);
      });
  }

  async insert(input: InsertRoutineRunInput): Promise<RoutineRun | null> {
    const durationMs = Math.max(
      0,
      input.finishedAt.getTime() - input.startedAt.getTime(),
    );
    try {
      const result = await this.pool.query<RoutineRunRow>(
        `INSERT INTO routine_runs
           (routine_id, tenant, user_id, trigger,
            started_at, finished_at, duration_ms, status, error_message,
            prompt, answer, iterations, tool_calls, run_trace)
         VALUES ($1, $2, $3, $4,
                 $5, $6, $7, $8, $9,
                 $10, $11, $12, $13, $14::jsonb)
         RETURNING ${SELECT_COLUMNS}`,
        [
          input.routineId,
          input.tenant,
          input.userId,
          input.trigger,
          input.startedAt,
          input.finishedAt,
          durationMs,
          input.status,
          input.errorMessage ?? null,
          input.prompt,
          input.answer ?? null,
          input.iterations ?? null,
          input.toolCalls ?? null,
          input.runTrace === undefined ? null : JSON.stringify(input.runTrace),
        ],
      );
      const row = result.rows[0];
      return row ? rowToRun(row) : null;
    } catch (err) {
      this.log(
        `[routines/runs] insert failed for routine=${input.routineId}: ${errMsg(err)}`,
      );
      return null;
    }
  }

  async listForRoutine(
    routineId: string,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<RoutineRun[]> {
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST_LIMIT);
    const result = await this.pool.query<RoutineRunRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM routine_runs
        WHERE routine_id = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [routineId, safeLimit],
    );
    return result.rows.map(rowToRun);
  }

  async get(runId: string): Promise<RoutineRun | null> {
    const result = await this.pool.query<RoutineRunRow>(
      `SELECT ${SELECT_COLUMNS} FROM routine_runs WHERE id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row ? rowToRun(row) : null;
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
