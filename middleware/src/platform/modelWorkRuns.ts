import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';

import { meterModelCalls, type ModelExecutionContext } from '@omadia/usage-telemetry';

import { auditActorFromRequest } from '../auth/adminAuditLog.js';

/**
 * Spec 2042 §5.10 — operator jobs and maintenance runs.
 *
 * Two execution contexts of the model gateway belong to no agent:
 *
 *   - An OPERATOR JOB is an admin function an operator starts explicitly in
 *     the admin UI (the issue preview, a skill verification, topic
 *     regrouping, bulk promotion, a builder's chat …). It runs under the
 *     starting operator, with exactly the effects it declares; its model
 *     calls share one budget, a deadline and a cancel. It never posts to a
 *     team conversation.
 *   - A MAINTENANCE RUN keeps an index current (the embedding backfill). It
 *     only embeds, never completes or transcribes, has a deadline per run and
 *     never posts to people.
 *
 * Both are charged to an instance budget per day (operator tools,
 * maintenance) and recorded in `model_work_runs` (migration 0089). A run
 * that hits its budget, deadline or cancel makes no further model call: the
 * gate refuses it, and the work fails at that call without further effects.
 */

export type ModelWorkContextKind = 'operator_job' | 'maintenance_run';
export type ModelWorkStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'budget_exhausted' | 'deadline';

export interface ModelWorkKind {
  /** e.g. `issue_preview`, `embedding_backfill`. */
  readonly kind: string;
  readonly context: ModelWorkContextKind;
  /** Model calls one run may make. */
  readonly budgetCalls: number;
  readonly deadlineMs: number;
  /** What the run may change, shown with it (e.g. `topics`). */
  readonly effects: readonly string[];
}

export interface ModelWorkRun {
  readonly id: string;
  readonly contextKind: ModelWorkContextKind;
  readonly jobKind: string;
  readonly startedBy: string | undefined;
  readonly effects: readonly string[];
  readonly budgetCalls: number;
  readonly modelCalls: number;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly endedAt: string | undefined;
  readonly status: ModelWorkStatus;
  readonly cancelledBy: string | undefined;
  readonly message: string | undefined;
}

/** Why a run was not started. */
export class ModelWorkBudgetError extends Error {
  readonly code = 'model_work.daily_budget_exhausted';
  constructor(context: ModelWorkContextKind, limit: number) {
    super(`the instance's daily ${context === 'operator_job' ? 'operator-tools' : 'maintenance'} budget of ${String(limit)} model calls is used up`);
    this.name = 'ModelWorkBudgetError';
  }
}

interface ModelWorkStore {
  insert(run: ModelWorkRun): Promise<void>;
  finish(id: string, patch: Pick<ModelWorkRun, 'status' | 'modelCalls' | 'message' | 'cancelledBy'>): Promise<void>;
  /** Model calls of runs of `context` started since `since`. */
  callsSince(context: ModelWorkContextKind, since: Date): Promise<number>;
  list(limit: number): Promise<ModelWorkRun[]>;
}

export interface ModelWorkRunsOptions {
  /** Absent: runs are kept in memory only (in-memory backend, tests). */
  readonly pool?: Pool;
  /** Model calls per day for all operator jobs together. */
  readonly operatorDailyCalls: number;
  /** Model calls per day for all maintenance runs together. */
  readonly maintenanceDailyCalls: number;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}

export interface ModelWorkRuns {
  /** Run `work` as one run of `kind`. Throws {@link ModelWorkBudgetError}
   *  when the instance's daily budget for its context is used up. */
  run<T>(kind: ModelWorkKind, startedBy: string | undefined, work: (run: { id: string; signal: AbortSignal }) => Promise<T>): Promise<T>;
  /** Express middleware: the rest of the request is one operator job. */
  middleware(kind: ModelWorkKind): RequestHandler;
  /** Cancel a running operator job. `false` when there is none. */
  cancel(id: string, by: string): boolean;
  list(limit?: number): Promise<ModelWorkRun[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createModelWorkRuns(options: ModelWorkRunsOptions): ModelWorkRuns {
  const store = options.pool ? pgStore(options.pool) : memoryStore();
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const running = new Map<string, { controller: AbortController; context: ModelWorkContextKind }>();

  const dailyLimit = (context: ModelWorkContextKind): number =>
    context === 'operator_job' ? options.operatorDailyCalls : options.maintenanceDailyCalls;

  async function run<T>(
    kind: ModelWorkKind,
    startedBy: string | undefined,
    work: (run: { id: string; signal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const started = now();
    const usedToday = await store.callsSince(kind.context, new Date(started.getTime() - DAY_MS));
    const left = dailyLimit(kind.context) - usedToday;
    if (left <= 0) throw new ModelWorkBudgetError(kind.context, dailyLimit(kind.context));
    const budget = Math.min(kind.budgetCalls, left);
    const id = randomUUID();
    const deadlineAt = started.getTime() + kind.deadlineMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), kind.deadlineMs);
    timer.unref();
    running.set(id, { controller, context: kind.context });
    await store.insert({
      id,
      contextKind: kind.context,
      jobKind: kind.kind,
      startedBy,
      effects: kind.effects,
      budgetCalls: budget,
      modelCalls: 0,
      startedAt: started.toISOString(),
      deadlineAt: new Date(deadlineAt).toISOString(),
      endedAt: undefined,
      status: 'running',
      cancelledBy: undefined,
      message: undefined,
    });
    const context: ModelExecutionContext = {
      kind: kind.context,
      ownerId: id,
      deadlineAt,
      signal: controller.signal,
      ...(kind.context === 'maintenance_run' ? { operations: ['embed'] as const } : {}),
    };
    const metered = await meterModelCalls(
      async (): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
        try {
          return { ok: true, value: await work({ id, signal: controller.signal }) };
        } catch (error) {
          return { ok: false, error };
        }
      },
      { limit: budget, context },
    );
    clearTimeout(timer);
    running.delete(id);
    const cancelledBy = (controller.signal.reason as { by?: string } | undefined)?.by;
    const outcome = metered.value;
    const status: ModelWorkStatus =
      cancelledBy !== undefined
        ? 'cancelled'
        : Date.now() > deadlineAt
          ? 'deadline'
          : metered.refused > 0
            ? 'budget_exhausted'
            : outcome.ok
              ? 'succeeded'
              : 'failed';
    const message = outcome.ok
      ? undefined
      : (outcome.error instanceof Error ? outcome.error.message : String(outcome.error)).slice(0, 1000);
    await store
      .finish(id, { status, modelCalls: metered.modelCalls, message, cancelledBy })
      .catch((err: unknown) =>
        log(`[model-work] recording the end of run ${id} failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  return {
    run,
    middleware(kind) {
      return (req: Request, res: Response, next: NextFunction): void => {
        // Reading a job's state starts nothing; only a request that runs the
        // function is one.
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
          next();
          return;
        }
        const actor = auditActorFromRequest(req);
        const startedBy = actor.email ?? actor.id;
        run(kind, startedBy, ({ id }) => {
          res.setHeader('x-omadia-operator-job', id);
          return new Promise<void>((resolve) => {
            res.once('close', resolve);
            next();
          });
        }).catch((err: unknown) => {
          if (err instanceof ModelWorkBudgetError && !res.headersSent) {
            res.status(429).json({ code: err.code, message: err.message });
            return;
          }
          log(`[model-work] operator job ${kind.kind} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      };
    },
    cancel(id, by) {
      const entry = running.get(id);
      if (!entry || entry.context !== 'operator_job') return false;
      entry.controller.abort({ by });
      return true;
    },
    list: (limit = 50) => store.list(limit),
  };
}

// --- stores ------------------------------------------------------------------

function memoryStore(): ModelWorkStore {
  const rows = new Map<string, ModelWorkRun>();
  return {
    insert: async (run) => {
      rows.set(run.id, run);
    },
    finish: async (id, patch) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...patch, endedAt: new Date().toISOString() });
    },
    callsSince: async (context, since) =>
      [...rows.values()]
        .filter((r) => r.contextKind === context && Date.parse(r.startedAt) >= since.getTime())
        .reduce((sum, r) => sum + (r.status === 'running' ? r.budgetCalls : r.modelCalls), 0),
    list: async (limit) => [...rows.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit),
  };
}

const COLS = `id, context_kind, job_kind, started_by, effects, budget_calls, model_calls,
  started_at, deadline_at, ended_at, status, cancelled_by, message`;

function rowToRun(r: Record<string, unknown>): ModelWorkRun {
  const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined);
  return {
    id: String(r['id']),
    contextKind: r['context_kind'] as ModelWorkContextKind,
    jobKind: String(r['job_kind']),
    startedBy: (r['started_by'] as string | null) ?? undefined,
    effects: (r['effects'] as string[] | null) ?? [],
    budgetCalls: Number(r['budget_calls']),
    modelCalls: Number(r['model_calls']),
    startedAt: iso(r['started_at']) ?? '',
    deadlineAt: iso(r['deadline_at']) ?? '',
    endedAt: iso(r['ended_at']),
    status: r['status'] as ModelWorkStatus,
    cancelledBy: (r['cancelled_by'] as string | null) ?? undefined,
    message: (r['message'] as string | null) ?? undefined,
  };
}

function pgStore(pool: Pool): ModelWorkStore {
  return {
    insert: async (run) => {
      await pool.query(
        `INSERT INTO model_work_runs (id, context_kind, job_kind, started_by, effects, budget_calls, started_at, deadline_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [run.id, run.contextKind, run.jobKind, run.startedBy ?? null, [...run.effects], run.budgetCalls, run.startedAt, run.deadlineAt],
      );
    },
    finish: async (id, patch) => {
      await pool.query(
        `UPDATE model_work_runs
            SET status = $2, model_calls = $3, message = $4, cancelled_by = $5, ended_at = now()
          WHERE id = $1`,
        [id, patch.status, patch.modelCalls, patch.message ?? null, patch.cancelledBy ?? null],
      );
    },
    // A running run counts with its whole budget: two jobs started at once
    // cannot both spend what is left.
    callsSince: async (context, since) => {
      const { rows } = await pool.query<{ used: string | null }>(
        `SELECT COALESCE(SUM(CASE WHEN status = 'running' THEN budget_calls ELSE model_calls END), 0) AS used
           FROM model_work_runs
          WHERE context_kind = $1 AND started_at >= $2`,
        [context, since],
      );
      return Number(rows[0]?.used ?? 0);
    },
    list: async (limit) => {
      const { rows } = await pool.query<Record<string, unknown>>(
        `SELECT ${COLS} FROM model_work_runs ORDER BY started_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map(rowToRun);
    },
  };
}
