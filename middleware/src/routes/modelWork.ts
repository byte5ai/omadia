import { Router, type Request, type Response } from 'express';

import { auditActorFromRequest } from '../auth/adminAuditLog.js';
import type { ModelWorkRun, ModelWorkRuns } from '../platform/modelWorkRuns.js';

/**
 * Spec 2042 §5.10 — operator jobs and maintenance runs, for the operator:
 *
 *   GET  /api/v1/admin/model-work              the newest runs
 *   POST /api/v1/admin/model-work/:id/cancel   cancel a running operator job
 *
 * A cancelled job makes no further model call; the function fails at its
 * next one without further effects.
 */
export function createModelWorkRouter(deps: { readonly runs: ModelWorkRuns }): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const raw = Number(req.query['limit']);
    const limit = Number.isInteger(raw) && raw > 0 && raw <= 200 ? raw : 50;
    try {
      res.json({ runs: (await deps.runs.list(limit)).map(runDto) });
    } catch (err) {
      res.status(500).json({ code: 'model_work.failed', message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/:id/cancel', (req: Request, res: Response) => {
    const actor = auditActorFromRequest(req);
    const id = String(req.params['id'] ?? '');
    if (!deps.runs.cancel(id, actor.email ?? actor.id ?? 'operator')) {
      res.status(404).json({ code: 'model_work.not_running', message: 'no running operator job with this id' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

function runDto(run: ModelWorkRun): Record<string, unknown> {
  return {
    id: run.id,
    context: run.contextKind,
    kind: run.jobKind,
    started_by: run.startedBy ?? null,
    effects: run.effects,
    budget_calls: run.budgetCalls,
    model_calls: run.modelCalls,
    started_at: run.startedAt,
    deadline_at: run.deadlineAt,
    ended_at: run.endedAt ?? null,
    status: run.status,
    cancelled_by: run.cancelledBy ?? null,
    message: run.message ?? null,
  };
}
