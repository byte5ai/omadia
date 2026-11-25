import type { Express, NextFunction, Request, Response } from 'express';

import {
  systemAuditActor,
  type AdminAuditLog,
} from '../auth/adminAuditLog.js';
import { bearerToken, createAdminRouter, hasAdminTokenBearer } from './admin.js';
import type { AdminTokenThrottle } from './adminTokenThrottle.js';

/** Where the machine-to-machine admin surface lives. */
export const ADMIN_TOKEN_PATH = '/api/admin';

/** The actor every row of a token-authenticated admin request carries. */
export const ADMIN_TOKEN_AUDIT_ACTOR = 'system:admin-token' as const;

export interface AdminTokenSurfaceDeps
  extends Omit<Parameters<typeof createAdminRouter>[0], 'token'> {
  /** `ADMIN_TOKEN`. Unset, empty or whitespace = the surface is not mounted. */
  readonly token: string | undefined;
  /**
   * The admin audit trail, resolved per request: it is constructed only when a
   * database is configured, after this mount. With a trail wired, a request
   * whose audit row cannot be written is refused (503) — the token never acts
   * unrecorded. Without one (DB-less boot) the use is logged instead.
   */
  readonly audit: () => AdminAuditLog | undefined;
  readonly log?: (line: string) => void;
  /** Clock for the refusal-row window; tests inject one. */
  readonly now?: () => number;
  /**
   * The per-client brake on wrong tokens (`adminTokenThrottle.ts`). A client
   * over it gets 429 before its token is compared. Absent = no brake.
   */
  readonly throttle?: AdminTokenThrottle;
}

/** At most one `admin_token.refused` row per window: a flood of wrong tokens
 *  must not flood the trail, but the first attempt of each minute is on it. */
const REFUSAL_AUDIT_WINDOW_MS = 60_000;

/**
 * The `ADMIN_TOKEN` break-glass surface, mounted BEFORE the blanket `/api`
 * session gate (OB-106). Mounted after it — where it used to be — every bearer
 * request was refused with the gate's `auth.missing` 401 before the token was
 * ever compared, so the surface `config.ts` promises was unreachable.
 *
 * Only a request that PRESENTS a bearer credential is claimed here; everything
 * else calls `next()` and meets the session gate exactly as before. That keeps
 * the session-authenticated neighbour on the same prefix
 * (`/api/admin/domains`, `graphRouterMounts.ts`) on its own auth. A bearer
 * request is terminal: a wrong token is a 401, a right one dispatches to the
 * admin router, and a path that router does not serve is a 404 — it never
 * travels on into the authenticated stack without a session. Deliberately NOT
 * an entry in `auth/publicPaths.ts`: that would open the whole prefix with the
 * gate's next(), including when no token is configured.
 *
 * Returns whether the surface was mounted.
 */
export function mountAdminTokenSurface(app: Express, deps: AdminTokenSurfaceDeps): boolean {
  const token = deps.token?.trim();
  if (!token) return false;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const router = createAdminRouter({ ...deps, token });
  const now = deps.now ?? Date.now;
  let lastRefusalAuditAt = Number.NEGATIVE_INFINITY;

  app.use(ADMIN_TOKEN_PATH, (req: Request, res: Response, next: NextFunction) => {
    if (bearerToken(req) === undefined) {
      next();
      return;
    }
    const waitMs = deps.throttle?.retryAfterMs(req) ?? 0;
    if (waitMs > 0) {
      log(`[admin-token] throttled ${req.method} ${ADMIN_TOKEN_PATH}${req.path}: too many wrong tokens`);
      res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)));
      res.status(429).json({ error: 'too_many_requests' });
      return;
    }
    if (!hasAdminTokenBearer(req, token)) {
      deps.throttle?.recordFailure(req);
      log(`[admin-token] refused ${req.method} ${ADMIN_TOKEN_PATH}${req.path}: wrong bearer token`);
      if (now() - lastRefusalAuditAt >= REFUSAL_AUDIT_WINDOW_MS) {
        lastRefusalAuditAt = now();
        void recordRefusal(req, deps.audit(), log);
      }
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    void recordUse(req, deps.audit(), log).then((recorded) => {
      if (!recorded) {
        res.status(503).json({ error: 'audit_unavailable' });
        return;
      }
      // Terminal: an error goes to the app's JSON error handler (500), an
      // unserved path is a 404 — neither travels on into the session stack.
      router(req, res, (err?: unknown) => {
        if (err !== undefined && err !== 'router') {
          next(err);
          return;
        }
        if (!res.headersSent) res.status(404).json({ error: 'not_found' });
      });
    });
  });
  return true;
}

const targetOf = (req: Request): string => `admin-api:${req.method} ${ADMIN_TOKEN_PATH}${req.path}`;

/** A wrong token, on record (best effort — the request is refused either way). */
async function recordRefusal(
  req: Request,
  audit: AdminAuditLog | undefined,
  log: (line: string) => void,
): Promise<void> {
  if (!audit) return;
  try {
    await audit.record({
      actor: systemAuditActor(ADMIN_TOKEN_AUDIT_ACTOR),
      action: 'admin_token.refused',
      target: targetOf(req),
    });
  } catch (err) {
    log(`[admin-token] refusal audit write failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Audit-first: true when the use is on record (or there is no trail to write). */
async function recordUse(
  req: Request,
  audit: AdminAuditLog | undefined,
  log: (line: string) => void,
): Promise<boolean> {
  const target = targetOf(req);
  if (!audit) {
    log(`[admin-token] ${target} (no audit trail configured)`);
    return true;
  }
  try {
    await audit.record({
      actor: systemAuditActor(ADMIN_TOKEN_AUDIT_ACTOR),
      action: 'admin_token.use',
      target,
    });
    return true;
  } catch (err) {
    log(
      `[admin-token] refused ${target}: audit write failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}
