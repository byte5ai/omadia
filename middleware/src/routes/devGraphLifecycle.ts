import { Router } from 'express';
import type { Request, Response } from 'express';

import type { LifecycleService } from '@omadia/knowledge-graph-neon/dist/lifecycleService.js';

interface DevGraphLifecycleDeps {
  lifecycle: LifecycleService;
}

/**
 * Operator-facing lifecycle admin endpoints (palaia Phase 4 / OB-73, Slice D).
 * Mounted under `/api/dev/graph/lifecycle` only when `DEV_ENDPOINTS_ENABLED`
 * is set. The web-dev page at `/admin/kg-lifecycle` consumes these routes
 * for the Tier-Histogram + manual-trigger buttons. Production deployments
 * never expose this — sweeps run on the cron schedule.
 *
 *   GET  /stats             — current Tier histogram + decay distribution
 *                             + top scopes by Turn count
 *   POST /run-decay         — flush access tracker + run decay-rotation now
 *   POST /run-gc            — run GC quota sweep now
 *   POST /run-access-flush  — flush access tracker (debug-only)
 *   GET  /last-runs         — last decay / GC / flush stats with timestamps
 */
export function createDevGraphLifecycleRouter(
  deps: DevGraphLifecycleDeps,
): Router {
  const router = Router();

  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await deps.lifecycle.getStats();
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  router.post('/run-decay', async (_req: Request, res: Response) => {
    try {
      const stats = await deps.lifecycle.runDecayNow();
      res.json({ ok: true, stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.post('/run-gc', async (_req: Request, res: Response) => {
    try {
      const stats = await deps.lifecycle.runGcNow();
      res.json({ ok: true, stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.post('/run-access-flush', async (_req: Request, res: Response) => {
    try {
      const stats = await deps.lifecycle.runAccessFlushNow();
      res.json({ ok: true, stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: message });
    }
  });

  router.get('/last-runs', (_req: Request, res: Response) => {
    res.json({
      decay: deps.lifecycle.lastDecay(),
      gc: deps.lifecycle.lastGc(),
      accessFlush: deps.lifecycle.lastAccessFlush(),
    });
  });

  return router;
}
