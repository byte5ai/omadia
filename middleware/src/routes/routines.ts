import { Router } from 'express';
import type { Request, Response } from 'express';

import {
  RoutineNotFoundError,
  type RoutineRunner,
} from '../plugins/routines/routineRunner.js';
import type {
  RoutineRun,
  RoutineRunsStore,
} from '../plugins/routines/routineRunsStore.js';
import type { Routine, RoutineStore } from '../plugins/routines/routineStore.js';

export interface RoutinesRouterDeps {
  store: RoutineStore;
  runsStore: RoutineRunsStore;
  runner: RoutineRunner;
  log?: (msg: string) => void;
}

export interface RoutineDto {
  id: string;
  tenant: string;
  userId: string;
  name: string;
  cron: string;
  prompt: string;
  channel: string;
  status: string;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
}

export interface ListRoutinesResponse {
  routines: RoutineDto[];
  count: number;
}

export interface RoutineResponse {
  routine: RoutineDto;
}

/**
 * Lightweight run summary for the per-routine list view. Excludes the
 * `runTrace` blob — that lives behind the single-run detail endpoint
 * because the listing path can have 50 rows and a full trace per row
 * would balloon the response.
 */
export interface RoutineRunSummaryDto {
  id: string;
  routineId: string;
  trigger: 'cron' | 'catchup' | 'manual';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'timeout';
  errorMessage: string | null;
  iterations: number | null;
  toolCalls: number | null;
}

export interface RoutineRunDetailDto extends RoutineRunSummaryDto {
  prompt: string;
  answer: string | null;
  /** Full agentic trace as stored in JSONB. Generic JSON-tree on the UI. */
  runTrace: unknown | null;
}

export interface ListRoutineRunsResponse {
  runs: RoutineRunSummaryDto[];
  count: number;
}

export interface RoutineRunResponse {
  run: RoutineRunDetailDto;
}

function toRunSummary(r: RoutineRun): RoutineRunSummaryDto {
  return {
    id: r.id,
    routineId: r.routineId,
    trigger: r.trigger,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    durationMs: r.durationMs,
    status: r.status,
    errorMessage: r.errorMessage,
    iterations: r.iterations,
    toolCalls: r.toolCalls,
  };
}

function toRunDetail(r: RoutineRun): RoutineRunDetailDto {
  return {
    ...toRunSummary(r),
    prompt: r.prompt,
    answer: r.answer,
    runTrace: r.runTrace,
  };
}

function toDto(r: Routine): RoutineDto {
  return {
    id: r.id,
    tenant: r.tenant,
    userId: r.userId,
    name: r.name,
    cron: r.cron,
    prompt: r.prompt,
    channel: r.channel,
    status: r.status,
    timeoutMs: r.timeoutMs,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    lastRunStatus: r.lastRunStatus,
    lastRunError: r.lastRunError,
  };
}

/**
 * Operator-grade observability + lifecycle endpoint for routines.
 *
 * Today the create flow is intentionally absent: a new routine only makes
 * sense with a real channel-native delivery handle (Teams
 * `conversationReference`), which only the inbound channel adapter
 * captures. Until the chat-create flow is wired, operators can list,
 * pause/resume, and delete — covering every observability and incident-
 * response need without producing orphan rows.
 *
 * Routes are mounted under `/api/v1/routines` and gated by `requireAuth`.
 *   GET    /                  → list all routines (cross-tenant)
 *   PATCH  /:id/status        → body `{status: 'active' | 'paused'}`
 *   POST   /:id/trigger       → fire one manual run (records as `manual` in routine_runs)
 *   GET    /:id/runs          → list per-routine run history (last 50 by default)
 *   GET    /:id/runs/:runId   → single run with full agentic trace (call-stack viewer)
 *   DELETE /:id               → permanent (cascades into routine_runs)
 */
export function createRoutinesRouter(deps: RoutinesRouterDeps): Router {
  const router = Router();
  const log = deps.log ?? ((m) => console.log(m));

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      // Operator view: include paused rows alongside active.
      // Cross-tenant list is acceptable here because the route is behind
      // requireAuth (operators-only).
      const rows = await deps.store.listAll();
      const body: ListRoutinesResponse = {
        routines: rows.map(toDto),
        count: rows.length,
      };
      res.json(body);
    } catch (err) {
      log(`[routines/route] GET / failed: ${errMsg(err)}`);
      res.status(500).json({ code: 'routines.list_failed', message: errMsg(err) });
    }
  });

  router.patch(
    '/:id/status',
    async (req: Request, res: Response): Promise<void> => {
      const idRaw = req.params['id'];
      const id = typeof idRaw === 'string' ? idRaw : '';
      const status = (req.body as { status?: string } | undefined)?.status;
      if (status !== 'active' && status !== 'paused') {
        res.status(400).json({
          code: 'routines.bad_status',
          message: "body.status must be 'active' or 'paused'",
        });
        return;
      }
      try {
        const updated =
          status === 'paused'
            ? await deps.runner.pauseRoutine(id)
            : await deps.runner.resumeRoutine(id);
        const body: RoutineResponse = { routine: toDto(updated) };
        res.json(body);
      } catch (err) {
        if (err instanceof RoutineNotFoundError) {
          res.status(404).json({ code: 'routines.not_found', message: err.message });
          return;
        }
        log(`[routines/route] PATCH /:id/status failed: ${errMsg(err)}`);
        res.status(500).json({
          code: 'routines.update_failed',
          message: errMsg(err),
        });
      }
    },
  );

  router.post(
    '/:id/trigger',
    async (req: Request, res: Response): Promise<void> => {
      const idRaw = req.params['id'];
      const id = typeof idRaw === 'string' ? idRaw : '';
      try {
        const updated = await deps.runner.triggerRoutineNow(id);
        const body: RoutineResponse = { routine: toDto(updated) };
        res.json(body);
      } catch (err) {
        if (err instanceof RoutineNotFoundError) {
          res
            .status(404)
            .json({ code: 'routines.not_found', message: err.message });
          return;
        }
        log(`[routines/route] POST /:id/trigger failed: ${errMsg(err)}`);
        res.status(500).json({
          code: 'routines.trigger_failed',
          message: errMsg(err),
        });
      }
    },
  );

  router.get(
    '/:id/runs',
    async (req: Request, res: Response): Promise<void> => {
      const idRaw = req.params['id'];
      const id = typeof idRaw === 'string' ? idRaw : '';
      const limitRaw = req.query['limit'];
      const limit =
        typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : 50;
      try {
        // Ensure parent exists so a 404 differs from "exists with zero runs".
        const parent = await deps.store.get(id);
        if (!parent) {
          res.status(404).json({
            code: 'routines.not_found',
            message: `routine '${id}' not found`,
          });
          return;
        }
        const rows = await deps.runsStore.listForRoutine(
          id,
          Number.isFinite(limit) ? limit : 50,
        );
        const body: ListRoutineRunsResponse = {
          runs: rows.map(toRunSummary),
          count: rows.length,
        };
        res.json(body);
      } catch (err) {
        log(`[routines/route] GET /:id/runs failed: ${errMsg(err)}`);
        res.status(500).json({
          code: 'routines.runs_list_failed',
          message: errMsg(err),
        });
      }
    },
  );

  router.get(
    '/:id/runs/:runId',
    async (req: Request, res: Response): Promise<void> => {
      const idRaw = req.params['id'];
      const runIdRaw = req.params['runId'];
      const id = typeof idRaw === 'string' ? idRaw : '';
      const runId = typeof runIdRaw === 'string' ? runIdRaw : '';
      try {
        const run = await deps.runsStore.get(runId);
        if (!run || run.routineId !== id) {
          res.status(404).json({
            code: 'routines.run_not_found',
            message: `run '${runId}' not found for routine '${id}'`,
          });
          return;
        }
        const body: RoutineRunResponse = { run: toRunDetail(run) };
        res.json(body);
      } catch (err) {
        log(`[routines/route] GET /:id/runs/:runId failed: ${errMsg(err)}`);
        res.status(500).json({
          code: 'routines.run_detail_failed',
          message: errMsg(err),
        });
      }
    },
  );

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const idRaw = req.params['id'];
    const id = typeof idRaw === 'string' ? idRaw : '';
    try {
      const ok = await deps.runner.deleteRoutine(id);
      if (!ok) {
        res.status(404).json({
          code: 'routines.not_found',
          message: `routine '${id}' not found`,
        });
        return;
      }
      res.status(204).end();
    } catch (err) {
      log(`[routines/route] DELETE /:id failed: ${errMsg(err)}`);
      res.status(500).json({
        code: 'routines.delete_failed',
        message: errMsg(err),
      });
    }
  });

  return router;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
