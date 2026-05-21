import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { TopicClusteringService } from '@omadia/plugin-api';

/**
 * Slice 11 — REST surface for the Topic-clustering workflow. Mounted
 * at `/api/v1/admin/topics`.
 *
 *   GET    /                      list (Topics, ordered by member_count DESC)
 *   GET    /:id                   detail with member MKs (ACL-gated per-member)
 *   POST   /recluster             trigger a destructive re-cluster
 */

const ReclusterBodySchema = z.object({
  similarityThreshold: z.coerce.number().min(0).max(1).optional(),
  minClusterSize: z.coerce.number().int().min(2).max(50).optional(),
});

function requireSessionUserId(req: Request, res: Response): string | null {
  const id = req.session?.omadia_user_id;
  if (!id) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return id;
}

export function createTopicsRouter(deps: {
  service: TopicClusteringService;
}): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    try {
      const items = await deps.service.list();
      res.json({ items });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'topics.list_failed', message });
    }
  });

  router.post('/recluster', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    const parsed = ReclusterBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        code: 'topics.invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      const opts: { similarityThreshold?: number; minClusterSize?: number } = {};
      if (parsed.data.similarityThreshold !== undefined) {
        opts.similarityThreshold = parsed.data.similarityThreshold;
      }
      if (parsed.data.minClusterSize !== undefined) {
        opts.minClusterSize = parsed.data.minClusterSize;
      }
      const result = await deps.service.recluster(opts);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'topics.recluster_failed', message });
    }
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const sessionUserId = requireSessionUserId(req, res);
    if (!sessionUserId) return;
    const id = String(req.params['id'] ?? '');
    try {
      const detail = await deps.service.getWithMembers(id, sessionUserId);
      if (!detail) {
        res.status(404).json({ code: 'topics.not_found' });
        return;
      }
      res.json(detail);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'topics.get_failed', message });
    }
  });

  return router;
}
