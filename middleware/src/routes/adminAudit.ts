import { Router } from 'express';
import type { Request, Response } from 'express';

import type { AdminAuditLog, AuditEntry } from '../auth/adminAuditLog.js';

interface AdminAuditDeps {
  audit: Pick<AdminAuditLog, 'list'>;
}

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;
/** Deep offsets make Postgres scan and discard rows; nobody pages this far by hand. */
export const AUDIT_OFFSET_MAX = 100_000;

/** `user.create`, `user.`, `profile_snapshot.rollback` — lower-case segments. */
const ACTION_FILTER_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACTION_FILTER_LENGTH = 64;

export interface AuditEntryDto {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
  created_at: string;
}

/**
 * #1315 — the read side of `admin_audit`. Mounted at `/api/v1/admin/audit`
 * behind `requireAuth`, like `/admin/users`: every user is an admin today
 * (single-role system), so the session gate is the admin gate.
 *
 *   GET /?limit=1..200&offset=>=0&action=<exact | prefix.>&actor_id=<uuid>
 *     → { entries, limit, offset, has_more }
 *
 * Newest first. `has_more` comes from reading one row past the page, so the
 * UI pages without a COUNT(*) over an append-only table that only grows.
 * Read-only by construction: the trail has no update or delete route.
 */
export function createAdminAuditRouter(deps: AdminAuditDeps): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    const query = parseAuditQuery(req.query);
    if (!query.ok) {
      res.status(400).json({ code: 'admin_audit.invalid_query', message: query.message });
      return;
    }
    const { limit, offset, action, actorId } = query;
    const rows = await deps.audit.list({
      limit: limit + 1,
      offset,
      ...(action !== undefined ? { action } : {}),
      ...(actorId !== undefined ? { actorId } : {}),
    });
    res.json({
      entries: rows.slice(0, limit).map(toDto),
      limit,
      offset,
      has_more: rows.length > limit,
    });
  });

  return router;
}

type ParsedAuditQuery =
  | { ok: true; limit: number; offset: number; action?: string; actorId?: string }
  | { ok: false; message: string };

export function parseAuditQuery(raw: Request['query']): ParsedAuditQuery {
  const limit = parseNonNegativeInt(raw['limit'], AUDIT_PAGE_DEFAULT);
  if (limit === undefined || limit < 1 || limit > AUDIT_PAGE_MAX) {
    return { ok: false, message: `limit must be an integer between 1 and ${String(AUDIT_PAGE_MAX)}` };
  }
  const offset = parseNonNegativeInt(raw['offset'], 0);
  if (offset === undefined || offset > AUDIT_OFFSET_MAX) {
    return { ok: false, message: `offset must be an integer between 0 and ${String(AUDIT_OFFSET_MAX)}` };
  }
  const action = raw['action'];
  if (action !== undefined) {
    if (
      typeof action !== 'string' ||
      action.length > MAX_ACTION_FILTER_LENGTH ||
      !ACTION_FILTER_RE.test(action)
    ) {
      return { ok: false, message: 'action must be an action name or a prefix ending in "."' };
    }
  }
  const actorId = raw['actor_id'];
  if (actorId !== undefined && (typeof actorId !== 'string' || !UUID_RE.test(actorId))) {
    return { ok: false, message: 'actor_id must be a uuid' };
  }
  return {
    ok: true,
    limit,
    offset,
    ...(typeof action === 'string' ? { action } : {}),
    ...(typeof actorId === 'string' ? { actorId } : {}),
  };
}

/** Absent → fallback; anything but a plain non-negative integer → undefined. */
function parseNonNegativeInt(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

function toDto(entry: AuditEntry): AuditEntryDto {
  return {
    id: entry.id,
    actor_id: entry.actorId,
    actor_email: entry.actorEmail,
    action: entry.action,
    target: entry.target,
    before: entry.before,
    after: entry.after,
    created_at: entry.createdAt.toISOString(),
  };
}
