import { createHash, timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { MemoryStore } from '@omadia/plugin-api';
import {
  getSecurityScreenMetrics,
  UNSCREENABLE_STREAK_ALERT,
  type RunTraceOutcomeStats,
} from '@omadia/orchestrator';

const PutBodySchema = z.object({
  path: z.string().min(1).startsWith('/memories'),
  content: z.string(),
  mode: z.enum(['create', 'overwrite']).default('overwrite'),
});

const DeleteBodySchema = z.object({
  path: z.string().min(1).startsWith('/memories'),
});

interface AdminDeps {
  store: MemoryStore;
  token: string;
  /** #1082 — the orchestrator's shared run-trace tally, resolved per request
   *  (`undefined` while no orchestrator is active). Read-only view: the route
   *  never records. */
  runTraceStats?: () =>
    | Pick<RunTraceOutcomeStats, 'snapshot' | 'droppedTotal' | 'captureTailOnlyTurns'>
    | undefined;
}

/**
 * Admin endpoints for priming and inspecting memory from outside the orchestrator.
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>`. Mounted only when ADMIN_TOKEN is set.
 */
export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();

  // Defence in depth: `mountAdminTokenSurface` already checked the bearer
  // before dispatching here, but the router must never serve without it.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!hasAdminTokenBearer(req, deps.token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  /**
   * #749 — is inbound security screening (#579) actually running?
   *
   * The counters are the answer to a question that had none. Screening is
   * fail-open: a screener that raises yields `unscreenable` and the turn
   * proceeds, so a totally broken screener is invisible from the outside. Until
   * #748 that was not hypothetical — every turn failed, screening was a no-op,
   * and nothing reported it.
   *
   * `healthy` is the derived judgement so an operator (or a probe) does not have
   * to know the threshold. It is false only on a RUN of failures, never on a
   * single miss: a transient miss is precisely what the fail-open policy exists
   * for, and flagging it would teach people to ignore this endpoint.
   */
  router.get('/security/screening', (_req: Request, res: Response) => {
    const metrics = getSecurityScreenMetrics();
    res.json({
      ...metrics,
      alertThreshold: UNSCREENABLE_STREAK_ALERT,
      healthy: metrics.consecutiveUnscreenable < UNSCREENABLE_STREAK_ALERT,
    });
  });

  /**
   * #684 / #1082 — run-trace outcomes and capture-filtered turns as numbers,
   * not only as log lines. `captureTailOnlyTurns` counts turns the capture
   * filter judged below the threshold and wrote for session continuity only;
   * it is a separate dimension, not part of `droppedTotal` (their traces are
   * `recorded`). Process-scoped, reset on restart or orchestrator reactivation.
   */
  router.get('/run-trace', (_req: Request, res: Response) => {
    const stats = deps.runTraceStats?.();
    if (!stats) {
      res.status(503).json({ error: 'run_trace_stats_unavailable' });
      return;
    }
    res.json({
      outcomes: stats.snapshot(),
      droppedTotal: stats.droppedTotal(),
      captureTailOnlyTurns: stats.captureTailOnlyTurns(),
    });
  });

  router.put('/memory', async (req: Request, res: Response) => {
    const parsed = PutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { path: virtualPath, content, mode } = parsed.data;
    try {
      if (mode === 'create') {
        await deps.store.createFile(virtualPath, content);
      } else {
        await deps.store.writeFile(virtualPath, content);
      }
      res.json({ ok: true, path: virtualPath, mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_write_failed', message });
    }
  });

  router.get('/memory/*path', async (req: Request, res: Response) => {
    const raw = req.params['path'];
    const segments = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const virtualPath = '/memories/' + segments.join('/');
    try {
      if (await deps.store.fileExists(virtualPath)) {
        const content = await deps.store.readFile(virtualPath);
        res.type('text/plain').send(content);
        return;
      }
      if (await deps.store.directoryExists(virtualPath)) {
        const entries = await deps.store.list(virtualPath);
        res.json({ path: virtualPath, entries });
        return;
      }
      res.status(404).json({ error: 'not_found', path: virtualPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_read_failed', message });
    }
  });

  router.delete('/memory', async (req: Request, res: Response) => {
    const parsed = DeleteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.store.delete(parsed.data.path);
      res.json({ ok: true, path: parsed.data.path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_delete_failed', message });
    }
  });

  // Danger-Zone memory purge lives on the cookie-auth `/api/v1/admin/memory/
  // purge` router (see `routes/memoryPurge.ts`), NOT here — the admin UI has
  // no client-side ADMIN_TOKEN.

  return router;
}

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

/** The bearer credential of a request, or `undefined` when it carries none. */
export function bearerToken(req: Request): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return undefined;
  // The auth scheme is case-insensitive (RFC 9110 §11.1), as in teamsSsoVerifier.
  return BEARER_RE.exec(header)?.[1];
}

/** True when the request presents exactly `token` as its bearer credential. */
export function hasAdminTokenBearer(req: Request, token: string): boolean {
  const supplied = bearerToken(req);
  return supplied !== undefined && constantTimeEqual(supplied, token);
}

/** Compares SHA-256 digests, so neither the content nor the length of the
 *  configured token leaks through timing. */
function constantTimeEqual(a: string, b: string): boolean {
  const digest = (v: string): Buffer => createHash('sha256').update(v, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}
