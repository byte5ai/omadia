import type { NextFunction, Request, Response } from 'express';

import type { SessionClaims, VerifiedSession } from './sessionJwt.js';
import { verifySession } from './sessionJwt.js';
import {
  SESSION_CHECK_UNAVAILABLE_CODE,
  SESSION_REVOKED_CODE,
  type SessionRevocation,
  type SessionVerdict,
} from './sessionRevocation.js';
import type { EmailWhitelist } from './whitelist.js';

export const SESSION_COOKIE = 'omadia_session';

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionClaims;
  }
}

/** Every way a session token can be refused. */
export type SessionFailureCode =
  | 'auth.missing'
  | 'auth.invalid'
  | 'auth.not_whitelisted'
  | typeof SESSION_REVOKED_CODE
  | typeof SESSION_CHECK_UNAVAILABLE_CODE;

/** Outcome of {@link evaluateSessionToken} — mirrors the response shape
 *  `requireAuth` sends on failure (`{code, message}`) so every caller of the
 *  shared evaluation (the Express middleware below AND the plugin-facing
 *  `ctx.operatorAuth` accessor) reports failures identically. */
export type SessionEvaluation =
  // `VerifiedSession` (a subtype of `SessionClaims`) so expiry-aware callers
  // (`POST /api/v1/auth/renew`, #965) read `exp`/`auth_time` from this same
  // evaluation instead of re-verifying the token on a second code path.
  | { readonly ok: true; readonly claims: VerifiedSession }
  | {
      readonly ok: false;
      readonly code: SessionFailureCode;
      readonly message: string;
    };

/** What {@link evaluateSessionToken} needs. */
export interface SessionEvaluationDeps {
  signingKey: Uint8Array;
  whitelist: EmailWhitelist;
  /**
   * Server-side revocation (`users.session_version`, see
   * `sessionRevocation.ts`). Production always wires it; it is optional only
   * so harnesses without a `users` table keep the signature-only verdict.
   */
  sessions?: Pick<SessionRevocation, 'check'>;
}

/**
 * HTTP status for a refused session — one mapping for every HTTP caller.
 * `auth.not_whitelisted` is an authorisation failure (403). A revocation
 * lookup that could not run is an outage (503): the web UI only bounces to
 * /login on a 401, so a database blip must not read as "signed out".
 * Everything else is a missing or dead credential (401).
 */
export function sessionFailureStatus(code: SessionFailureCode): 401 | 403 | 503 {
  if (code === 'auth.not_whitelisted') return 403;
  if (code === SESSION_CHECK_UNAVAILABLE_CODE) return 503;
  return 401;
}

/**
 * The single code path that decides whether a session token is currently
 * valid — extracted so `requireAuth` (below), the kernel's `ctx.operatorAuth`
 * accessor (`operatorAuthAccessor.ts`), the channel WebSocket upgrade and
 * `POST /renew` can never drift apart on what "a valid operator session"
 * means. In order: verify the JWT against `signingKey`, apply the
 * Entra-whitelist gate (local-provider sessions skip it — see the doc comment
 * below), then ask the revocation guard whether the account still vouches for
 * the session.
 */
export async function evaluateSessionToken(
  token: string | undefined,
  deps: SessionEvaluationDeps,
): Promise<SessionEvaluation> {
  const verified = await verifyAndGate(token, deps);
  if (!verified.ok || !deps.sessions) return verified;
  return applyRevocation(verified.claims, deps.sessions);
}

async function verifyAndGate(
  token: string | undefined,
  deps: SessionEvaluationDeps,
): Promise<SessionEvaluation> {
  if (!token) {
    return { ok: false, code: 'auth.missing', message: 'no session' };
  }
  try {
    const claims = await verifySession(token, deps.signingKey);
    // Whitelist gate applies only to OIDC-managed identities. Local
    // users rely on the users-table status (checked by the revocation step).
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
 * The revocation step on its own, for callers that verified the token
 * themselves (`GET /me` skips the whitelist gate on purpose). Deliberately
 * NOT inside the signature try/catch above: that catch turns everything into
 * `auth.invalid`, and a store outage is not a bad credential.
 */
export async function applyRevocation(
  claims: VerifiedSession,
  sessions: Pick<SessionRevocation, 'check'>,
): Promise<SessionEvaluation> {
  let verdict: SessionVerdict;
  try {
    verdict = await sessions.check(claims);
  } catch (err) {
    // The kernel guard never throws; any other implementation that does is
    // an outage too, never a verdict on the credential.
    console.error(
      '[auth] session revocation check threw:',
      err instanceof Error ? err.message : err,
    );
    verdict = 'unavailable';
  }
  if (verdict === 'ok') return { ok: true, claims };
  return verdict === 'revoked'
    ? { ok: false, code: SESSION_REVOKED_CODE, message: 'session revoked' }
    : {
        ok: false,
        code: SESSION_CHECK_UNAVAILABLE_CODE,
        message: 'session check unavailable, try again',
      };
}

/**
 * Gate for /api/v1/* routes (except /api/v1/auth/*).
 *
 * Per-provider authorisation rules:
 *   - **entra** (and any future OIDC plugin): the email must be on the
 *     `ADMIN_ALLOWED_EMAILS` whitelist. The whitelist decides who may hold an
 *     Entra session at all; the OIDC callback also upserts a `users` row for
 *     every Entra sign-in, and that row carries the revocation state below.
 *   - **local** (LocalPasswordProvider): no whitelist check — the JWT was
 *     minted from a verified password and an `active` user-row.
 *
 * For both, the `users` row is re-read on every request (`sessions`, see
 * `sessionRevocation.ts`): a session stands only while its row exists, is
 * `active`, is the row it was minted for and still has the session version
 * the token carries. Sign-out, an admin password reset, disabling and
 * deleting the account therefore end its sessions on the next request, not
 * when the cookie expires.
 *
 * Strict: missing/invalid/expired/revoked cookie → 401. Whitelist-rejected
 * (Entra path only) → 403. Revocation lookup failed → 503 (an outage, so the
 * UI does not sign the operator out). Admin UI redirects to /login on 401.
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
export function createRequireAuth(
  deps: SessionEvaluationDeps & {
    /** Optional regex list matched against `req.originalUrl`. Requests
     *  whose URL matches ANY pattern bypass the cookie check and proceed
     *  to the next handler. Use sparingly — every entry is a potential
     *  unauthenticated surface. */
    publicPaths?: readonly RegExp[];
  },
) {
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
      res
        .status(sessionFailureStatus(result.code))
        .json({ code: result.code, message: result.message });
      return;
    }
    req.session = result.claims;
    next();
  };
}
