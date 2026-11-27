import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { BulkPromotionService } from '@omadia/plugin-api';

import { auditActorFromRequest, type AdminAuditLog } from '../auth/adminAuditLog.js';

/**
 * Slice 8 — REST surface for the operator-triggered bulk score +
 * promotion job. Mounted under `/api/v1/admin/bulk-promote`.
 *
 * Endpoints:
 *   GET  /preview?threshold=0.7  → cheap counts query (no LLM call)
 *   POST /                       → runs both phases, returns stats
 *   GET  /retired?limit=100      → #2295: turns retired from promotion
 *   POST /unretire { turnId }    → #2295: make one promotable again (audited)
 *
 * Both gated by `requireSessionUserId` (single-tenant byte5 — every
 * authenticated session is an operator).
 */

const PreviewQuerySchema = z.object({
  threshold: z.coerce.number().min(0).max(1).optional(),
});

const RunBodySchema = z.object({
  scoreLimit: z.number().int().min(1).max(1000).optional(),
  promoteLimit: z.number().int().min(1).max(1000).optional(),
  threshold: z.number().min(0).max(1).optional(),
});

const RetiredQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const UnretireBodySchema = z.object({
  turnId: z.string().min(1).max(512),
});

function requireSessionUserId(req: Request, res: Response): string | null {
  const id = req.session?.omadia_user_id;
  if (!id) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return id;
}

export function createBulkPromotionRouter(deps: {
  service: BulkPromotionService;
  /** #2295 — records `memory.promotion_unretire`; absent ⇒ not recorded. */
  adminAudit?: AdminAuditLog;
}): Router {
  const router = Router();

  router.get('/retired', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    const list = deps.service.listRetired?.bind(deps.service);
    if (!list) {
      res.status(501).json({ code: 'bulk.unretire_unsupported' });
      return;
    }
    const parsed = RetiredQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ code: 'bulk.invalid_query', issues: parsed.error.issues });
      return;
    }
    try {
      res.json({ turns: await list({ ...(parsed.data.limit ? { limit: parsed.data.limit } : {}) }) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'bulk.retired_failed', message });
    }
  });

  // An operator act: the audit row is written first, and a failed write
  // refuses the change (same rule as the memory purge).
  router.post('/unretire', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    const unretire = deps.service.unretire?.bind(deps.service);
    if (!unretire) {
      res.status(501).json({ code: 'bulk.unretire_unsupported' });
      return;
    }
    const parsed = UnretireBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ code: 'bulk.invalid_request', issues: parsed.error.issues });
      return;
    }
    const { turnId } = parsed.data;
    if (deps.adminAudit) {
      try {
        await deps.adminAudit.record({
          actor: auditActorFromRequest(req),
          action: 'memory.promotion_unretire',
          target: `turn:${turnId}`,
        });
      } catch (err) {
        console.error('[bulk-promote] audit write failed, unretire refused:', err instanceof Error ? err.message : err);
        res.status(500).json({ code: 'audit_write_failed' });
        return;
      }
    }
    try {
      const outcome = await unretire(turnId);
      if (outcome === 'unretired') {
        res.json({ ok: true, turnId });
        return;
      }
      res.status(outcome === 'not_found' ? 404 : 409).json({ code: `bulk.unretire_${outcome}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'bulk.unretire_failed', message });
    }
  });

  router.get('/preview', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    const parsed = PreviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'bulk.invalid_query', issues: parsed.error.issues });
      return;
    }
    try {
      const preview = await deps.service.preview(parsed.data.threshold ?? 0.7);
      res.json(preview);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'bulk.preview_failed', message });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    const parsed = RunBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ code: 'bulk.invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      const result = await deps.service.run(parsed.data);
      res.json(result);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'bulk.scorer_unavailable'
      ) {
        res.status(503).json({
          code: 'bulk.scorer_unavailable',
          message:
            'No SignificanceScorer is configured — set ANTHROPIC_API_KEY to enable the bulk score phase.',
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'bulk.run_failed', message });
    }
  });

  return router;
}
