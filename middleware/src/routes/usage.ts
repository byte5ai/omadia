import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';

import { getUsageDashboard } from '@omadia/usage-telemetry';

/**
 * Cost-telemetry read surface for the web-ui dashboard. Mounted at
 * `/api/usage`. Read-only aggregations over the append-only `token_usage`
 * ledger written by @omadia/usage-telemetry.
 *
 *   GET /dashboard?since&until&bucket   totals + per-model + per-source + series
 *
 * `since`/`until` are ISO timestamps (omit for all-time); `bucket` is
 * 'hour' | 'day' (default 'hour'). Only available when a graphPool exists
 * (Neon backend) — in in-memory mode no usage is persisted, so the route is
 * not mounted.
 */

const QuerySchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  bucket: z.enum(['hour', 'day']).optional(),
});

function requireSessionUserId(req: Request, res: Response): string | null {
  const id = req.session?.omadia_user_id;
  if (!id) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return id;
}

export function createUsageRouter(deps: { pool: Pool }): Router {
  const router = Router();

  router.get('/dashboard', async (req: Request, res: Response) => {
    if (!requireSessionUserId(req, res)) return;
    const parsed = QuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({
        code: 'usage.invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    try {
      const window: { since?: string; until?: string } = {};
      if (parsed.data.since !== undefined) window.since = parsed.data.since;
      if (parsed.data.until !== undefined) window.until = parsed.data.until;
      const dashboard = await getUsageDashboard(
        deps.pool,
        window,
        parsed.data.bucket ?? 'hour',
      );
      res.json(dashboard);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'usage.dashboard_failed', message });
    }
  });

  return router;
}
