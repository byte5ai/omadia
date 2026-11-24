import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';

import { createEcbEurRateSource, getUsageDashboard, type FxRate } from '@omadia/usage-telemetry';

/**
 * Cost-telemetry read surface for the web-ui dashboard. Mounted at
 * `/api/usage`. Read-only aggregations over the append-only `token_usage`
 * ledger written by @omadia/usage-telemetry.
 *
 *   GET /dashboard?since&until&bucket&tz   totals + per-model + per-source + series
 *                                          + `fx` (ECB USD→EUR rate, or null)
 *
 * `since`/`until` are ISO timestamps (omit for all-time); `bucket` is
 * 'hour' | 'day' (default 'hour'); `tz` is the IANA zone the buckets are cut in
 * (default 'UTC', #1396) — `since` is floored to its bucket start in that zone.
 * Only available when a graphPool exists
 * (Neon backend) — in in-memory mode no usage is persisted, so the route is
 * not mounted.
 */

/**
 * #1396 — an IANA zone name (`Europe/Berlin`, `UTC`, `Etc/GMT+5`). It reaches
 * Postgres only as a bind parameter, so the gate is about meaning, not
 * injection: a bare offset like `+02:00` is refused because Postgres reads it
 * with POSIX sign semantics (east-negative), the opposite of what a browser
 * means. `Intl` is the authority on which names exist.
 */
const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9/_+-]{0,63}$/;
export function isIanaTimeZone(value: string): boolean {
  if (!TIME_ZONE_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const QuerySchema = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  bucket: z.enum(['hour', 'day']).optional(),
  tz: z.string().refine(isIanaTimeZone, 'not an IANA time zone').optional(),
}).refine((q) => q.bucket !== 'hour' || q.since !== undefined, {
  // An all-time hourly series is one row per hour since the first call ever.
  message: 'bucket=hour needs since',
  path: ['since'],
});

/** Postgres `invalid_parameter_value` — what an unknown `AT TIME ZONE` raises. */
const PG_INVALID_PARAMETER_VALUE = '22023';

function requireSessionUserId(req: Request, res: Response): string | null {
  const id = req.session?.omadia_user_id;
  if (!id) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return id;
}

export interface UsageRouterDeps {
  readonly pool: Pool;
  /**
   * USD→EUR rate for the EUR view. Defaults to the cached ECB daily rate;
   * `USAGE_FX_DISABLED=true` turns that outbound call off (no EUR view).
   */
  readonly eurRate?: () => Promise<FxRate | null>;
}

/**
 * How long the dashboard waits for a rate refresh before answering without
 * one. The refresh keeps running and fills the cache for the next load, so a
 * slow or unreachable ECB never slows the page down by more than this.
 */
const FX_WAIT_MS = 1500;

function defaultEurRate(): () => Promise<FxRate | null> {
  if (process.env['USAGE_FX_DISABLED'] === 'true') return async () => null;
  return createEcbEurRateSource();
}

function withinBudget<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

export function createUsageRouter(deps: UsageRouterDeps): Router {
  const router = Router();
  const eurRate = deps.eurRate ?? defaultEurRate();

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
      const bucket = parsed.data.bucket ?? 'hour';
      const tz = parsed.data.tz ?? 'UTC';
      // Started alongside the queries; it never throws (null = USD only).
      const fx = withinBudget(eurRate(), FX_WAIT_MS);
      let dashboard;
      try {
        dashboard = await getUsageDashboard(deps.pool, window, bucket, tz);
      } catch (err) {
        // A zone the browser's ICU knows but this Postgres' tzdata does not
        // passes the gate above. Cut in UTC rather than fail the whole page.
        if ((err as { code?: unknown }).code !== PG_INVALID_PARAMETER_VALUE || tz === 'UTC') throw err;
        console.warn(`[usage] time zone '${tz}' unknown to Postgres — bucketing in UTC`);
        dashboard = await getUsageDashboard(deps.pool, window, bucket, 'UTC');
      }
      res.json({ ...dashboard, fx: await fx });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ code: 'usage.dashboard_failed', message });
    }
  });

  return router;
}
