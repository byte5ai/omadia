import type { Router, Request, Response } from 'express';

import type { DraftStore } from '../plugins/builder/draftStore.js';

/**
 * Issue #56 — paginated audit-log surface.
 *
 *   GET /v1/builder/drafts/:id/audit?limit=30&offset=0
 *
 * Owner-scoped: the DraftStore.listAudit filter pins to the calling
 * session's `userEmail`, so cross-user lookups return an empty page
 * rather than another operator's audit trail. The route is mounted
 * via `routes/builder.ts`, picking up the existing auth gate around
 * the entire `/v1/builder/*` mount.
 */

export interface BuilderAuditDeps {
  draftStore: DraftStore;
}

export function registerBuilderAuditRoute(
  router: Router,
  deps: BuilderAuditDeps,
): void {
  router.get('/drafts/:id/audit', async (req: Request, res: Response) => {
    const email = readEmail(req);
    if (!email) {
      return sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
    }
    const draftId = readId(req);
    if (!draftId) {
      return sendJson(res, 400, {
        code: 'builder.invalid_id',
        message: 'missing :id',
      });
    }

    const limit = clampInt(req.query['limit'], 1, 200, 30);
    const offset = clampInt(req.query['offset'], 0, 100_000, 0);

    // Confirm the draft is reachable by this user before listing audit
    // events. Without this, a leaked draft id would still return 200
    // with an empty page; 404 is the friendlier signal.
    const draft = await deps.draftStore.load(email, draftId);
    if (!draft) {
      return sendJson(res, 404, {
        code: 'builder.draft_not_found',
        message: `kein Draft mit id '${draftId}'`,
      });
    }

    const page = await deps.draftStore.listAudit(email, draftId, { limit, offset });
    res.json({
      draftId,
      total: page.total,
      limit,
      offset,
      events: page.events,
    });
  });
}

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

function readId(req: Request): string | null {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function sendJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): void {
  res.status(status).json(body);
}

function clampInt(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
