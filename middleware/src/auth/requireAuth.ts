import type { NextFunction, Request, Response } from 'express';

import type { SessionClaims } from './sessionJwt.js';
import { verifySession } from './sessionJwt.js';
import type { EmailWhitelist } from './whitelist.js';

export const SESSION_COOKIE = 'omadia_session';

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionClaims;
  }
}

/**
 * Gate for /api/v1/* routes (except /api/v1/auth/*).
 *
 * Per-provider authorisation rules:
 *   - **entra** (and any future OIDC plugin): the email must be on the
 *     `ADMIN_ALLOWED_EMAILS` whitelist. Whitelist is the single source of
 *     truth for Entra-issued sessions because IdP-managed users don't
 *     have a row in our local `users` table until V1.x admin-list shows
 *     them.
 *   - **local** (LocalPasswordProvider): no whitelist check — the JWT was
 *     minted from a verified password and an `active` user-row, so the
 *     cookie's existence IS the authorisation. Status changes propagate
 *     within the 4h cookie lifetime; V1.x will add a server-side revoke
 *     store.
 *
 * Strict: missing/invalid/expired cookie → 401. Whitelist-rejected
 * (Entra path only) → 403. Admin UI redirects to /login on 401.
 *
 * Public-path bypass (post-deploy 2026-05-14 hotfix): OB-106 mounted
 * `requireAuth` at the broad `/api` prefix to cover the chat-inference
 * endpoints. That side-effect-blocked `/api/v1/auth/*` (login-providers,
 * login, setup) which MUST be reachable without a session cookie —
 * otherwise an expired cookie traps the user in a 401 loop and the
 * login page can't even load its provider list. The publicPaths regex
 * list short-circuits to `next()` so other gates downstream (per-route
 * requireAuth, defence-in-depth) still apply.
 */
export function createRequireAuth(deps: {
  signingKey: Uint8Array;
  whitelist: EmailWhitelist;
  /** Optional regex list matched against `req.originalUrl`. Requests
   *  whose URL matches ANY pattern bypass the cookie check and proceed
   *  to the next handler. Use sparingly — every entry is a potential
   *  unauthenticated surface. */
  publicPaths?: readonly RegExp[];
}) {
  const publicPaths = deps.publicPaths ?? [];
  return async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (publicPaths.length > 0 && publicPaths.some((p) => p.test(req.originalUrl))) {
      next();
      return;
    }
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    const token = cookies ? cookies[SESSION_COOKIE] : undefined;
    if (!token) {
      res.status(401).json({ code: 'auth.missing', message: 'no session' });
      return;
    }
    try {
      const claims = await verifySession(token, deps.signingKey);
      // Whitelist gate applies only to OIDC-managed identities. Local
      // users rely on the users-table status (already checked at login).
      if (claims.provider === 'entra' && !deps.whitelist.isAllowed(claims.email)) {
        res
          .status(403)
          .json({ code: 'auth.not_whitelisted', message: 'email no longer authorised' });
        return;
      }
      req.session = claims;
      next();
    } catch {
      res.status(401).json({ code: 'auth.invalid', message: 'session invalid or expired' });
    }
  };
}
