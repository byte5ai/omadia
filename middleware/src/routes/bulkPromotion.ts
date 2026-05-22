import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { BulkPromotionService } from '@omadia/plugin-api';

/**
 * Slice 8 — REST surface for the operator-triggered bulk score +
 * promotion job. Mounted under `/api/v1/admin/bulk-promote`.
 *
 * Two endpoints:
 *   GET  /preview?threshold=0.7  → cheap counts query (no LLM call)
 *   POST /                       → runs both phases, returns stats
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
}): Router {
  const router = Router();

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
