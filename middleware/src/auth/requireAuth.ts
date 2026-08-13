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

/** Outcome of {@link evaluateSessionToken} — mirrors the response shape
 *  `requireAuth` sends on failure (`{code, message}`) so every caller of the
 *  shared evaluation (the Express middleware below AND the plugin-facing
 *  `ctx.operatorAuth` accessor) reports failures identically. */
export type SessionEvaluation =
  | { readonly ok: true; readonly claims: SessionClaims }
  | {
      readonly ok: false;
      readonly code: 'auth.missing' | 'auth.invalid' | 'auth.not_whitelisted';
      readonly message: string;
    };

/**
 * The single code path that decides whether a session token is currently
 * valid — extracted so `requireAuth` (below) and the kernel's
 * `ctx.operatorAuth` accessor (`operatorAuthAccessor.ts`) can never drift
 * apart on what "a valid operator session" means. Same rule either caller
 * uses: verify the JWT against `signingKey`, then apply the Entra-whitelist
 * gate (local-provider sessions skip it — see the doc comment below).
 */
export async function evaluateSessionToken(
  token: string | undefined,
  deps: { signingKey: Uint8Array; whitelist: EmailWhitelist },
): Promise<SessionEvaluation> {
  if (!token) {
    return { ok: false, code: 'auth.missing', message: 'no session' };
  }
  try {
    const claims = await verifySession(token, deps.signingKey);
    // Whitelist gate applies only to OIDC-managed identities. Local
    // users rely on the users-table status (already checked at login).
    if (claims.provider === 'entra' && !deps.whitelist.isAllowed(claims.email)) {
      return {
        ok: false,
        code: 'auth.not_whitelisted',
        message: 'email no longer authorised',
      };
    }
    return { ok: true, claims };
  } catch {
    return { ok: false, code: 'auth.invalid', message: 'session invalid or expired' };
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
    const result = await evaluateSessionToken(token, deps);
    if (!result.ok) {
      const status = result.code === 'auth.not_whitelisted' ? 403 : 401;
      res.status(status).json({ code: result.code, message: result.message });
      return;
    }
    req.session = result.claims;
    next();
  };
}
