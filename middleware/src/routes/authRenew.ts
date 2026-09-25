import type { Request, Response } from 'express';

import type { AdminAuditLog } from '../auth/adminAuditLog.js';
import { isOidcProvider } from '../auth/providers/AuthProvider.js';
import type { ProviderRegistry } from '../auth/providerRegistry.js';
import type { RefreshStore } from '../auth/refreshStore.js';
import { evaluateSessionToken, SESSION_COOKIE } from '../auth/requireAuth.js';
import { SESSION_WINDOW_S, setSessionCookie } from '../auth/sessionCookie.js';
import { signSession, type VerifiedSession } from '../auth/sessionJwt.js';
import type { UserStore } from '../auth/userStore.js';
import type { EmailWhitelist } from '../auth/whitelist.js';

/**
 * #965 — everything `POST /api/v1/auth/renew` needs beyond the base auth
 * router deps. Optional on `AuthDeps` so harnesses that never renew keep
 * compiling; without it `/renew` answers 503 and `/me` reports
 * `renewable_until: null`, which the UI reads as "sign in again".
 */
export interface SessionRenewalDeps {
  /** Same whitelist `requireAuth` applies on every request. */
  whitelist: EmailWhitelist;
  /** One row per renewal. Written BEFORE the cookie is set, so a failed
   *  audit write can never produce a renewed session. */
  audit: Pick<AdminAuditLog, 'record'>;
  /** Entra refresh tokens. `/logout` forgets the user's token so a logout
   *  ends the renewal chain. Absent when no OIDC provider is wired. */
  refreshStore?: Pick<RefreshStore, 'forget'>;
  /** Absolute cap on a renewal chain, in seconds, measured from the
   *  session's `auth_time` (`AUTH_SESSION_MAX_LIFETIME_HOURS * 3600`). */
  maxLifetimeSeconds: number;
}

interface RenewHandlerDeps {
  registry: ProviderRegistry;
  userStore: Pick<UserStore, 'findByProviderUserId'>;
  signingKey: Uint8Array;
  renewal?: SessionRenewalDeps;
}

/** Last moment (Unix epoch seconds) a session with this `auth_time` may be
 *  valid, or null when renewal is not wired. Shared by `/me` and `/renew`
 *  so both report the same boundary. */
export function renewableUntil(
  authTime: number,
  renewal: SessionRenewalDeps | undefined,
): number | null {
  return renewal ? authTime + renewal.maxLifetimeSeconds : null;
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message });
}

type IdentityCheck =
  | { ok: true; userRowId: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * Re-check that the principal behind the cookie may still hold a session:
 * provider still active, users-row present and `active`, and (for OIDC)
 * the IdP still vouching for the identity. Fails closed at every step.
 */
async function checkIdentity(
  deps: RenewHandlerDeps,
  claims: VerifiedSession,
): Promise<IdentityCheck> {
  const denied = (message: string): IdentityCheck => ({
    ok: false,
    status: 401,
    code: 'auth.renew_denied',
    message,
  });
  const provider = deps.registry.get(claims.provider);
  if (!provider) return denied('sign-in provider is no longer active');

  const row = await deps.userStore.findByProviderUserId(claims.provider, claims.sub);
  if (!row || row.status !== 'active') return denied('account is not active');

  if (isOidcProvider(provider)) {
    if (!provider.revalidateSession) {
      return denied('provider cannot re-validate sessions');
    }
    const verdict = await provider.revalidateSession({
      email: claims.email,
      providerUserId: claims.sub,
    });
    if (verdict.outcome !== 'ok') {
      console.warn(
        `[auth] /renew: ${claims.provider} re-validation ${verdict.outcome} for ${claims.email}: ${verdict.message}`,
      );
      if (verdict.outcome === 'unavailable') {
        return {
          ok: false,
          status: 502,
          code: 'auth.renew_idp_unavailable',
          message: 'identity provider unreachable, try again',
        };
      }
      return denied('identity provider refused the renewal');
    }
  }
  return { ok: true, userRowId: row.id };
}

/**
 * `POST /api/v1/auth/renew` — explicit "I'm still here" extension (#965).
 *
 * Order matters and every step fails closed:
 *   1. the cookie must be valid right now (same `evaluateSessionToken` as
 *      `requireAuth`, whitelist gate included) — an expired session can
 *      only be replaced by a login, never renewed;
 *   2. the absolute cap from `auth_time` must not be reached;
 *   3. the principal is re-checked (provider, users-row, IdP);
 *   4. the current `exp` must not already sit on the cap (final window);
 *      the new window is `min(now + 4h, auth_time + cap)`;
 *   5. the audit row is written — before the cookie, so a failed write
 *      (bubbling to Express as a 500) never yields a renewed session;
 *   6. the same claims are re-signed, `auth_time` carried over.
 */
export function createRenewHandler(deps: RenewHandlerDeps) {
  return async function renew(req: Request, res: Response): Promise<void> {
    const renewal = deps.renewal;
    if (!renewal) {
      refuse(res, 503, 'auth.renew_unavailable', 'session renewal is not configured');
      return;
    }
    const cookies =
      (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const evaluation = await evaluateSessionToken(cookies[SESSION_COOKIE], {
      signingKey: deps.signingKey,
      whitelist: renewal.whitelist,
    });
    if (!evaluation.ok) {
      const status = evaluation.code === 'auth.not_whitelisted' ? 403 : 401;
      refuse(res, status, evaluation.code, evaluation.message);
      return;
    }
    const claims = evaluation.claims;
    const now = Math.floor(Date.now() / 1000);
    const capEnd = claims.auth_time + renewal.maxLifetimeSeconds;
    if (now >= capEnd) {
      refuse(res, 401, 'auth.renew_expired', 'maximum session lifetime reached');
      return;
    }

    const identity = await checkIdentity(deps, claims);
    if (!identity.ok) {
      refuse(res, identity.status, identity.code, identity.message);
      return;
    }

    // Final window: the current `exp` already sits on the cap, so no renewal
    // can extend it. Refused like a cap overrun (the UI shows re-login for
    // this window up front via `renewable_until`). Below the cap a renewal
    // always yields `newExp >= exp`, since every window is 4h from mint.
    if (claims.exp >= capEnd) {
      refuse(res, 401, 'auth.renew_expired', 'maximum session lifetime reached');
      return;
    }
    const newExp = Math.min(now + SESSION_WINDOW_S, capEnd);

    await renewal.audit.record({
      actor: { id: identity.userRowId, email: claims.email },
      action: 'auth.session_renew',
      target: `user:${identity.userRowId}`,
      before: { provider: claims.provider, exp: claims.exp, auth_time: claims.auth_time },
      after: { exp: newExp },
    });

    const token = await signSession(
      {
        sub: claims.sub,
        email: claims.email,
        display_name: claims.display_name,
        role: claims.role,
        provider: claims.provider,
        ...(claims.omadia_user_id ? { omadia_user_id: claims.omadia_user_id } : {}),
        auth_time: claims.auth_time,
      },
      deps.signingKey,
      newExp,
    );
    setSessionCookie(req, res, token, newExp - now);
    res.json({ expires_at: newExp, server_now: now, renewable_until: capEnd });
  };
}
