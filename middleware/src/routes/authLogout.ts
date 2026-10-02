import { ENTRA_PROVIDER_ID } from '../auth/providers/EntraProvider.js';
import type { RefreshStore } from '../auth/refreshStore.js';
import type { VerifiedSession } from '../auth/sessionJwt.js';
import {
  accountVouchesFor,
  type SessionRevocation,
} from '../auth/sessionRevocation.js';
import type { UserStore } from '../auth/userStore.js';

/**
 * What `POST /logout` did on the server:
 *
 * - `revoked` — the presented cookie was current, so the user's session
 *   version moved on and every session of that user (every device) ended.
 * - `stale` — the cookie was already revoked (or its row is gone). Nothing
 *   changes server-side: a copied cookie that no longer works must not be
 *   able to sign its owner out of the sessions they hold now, and the auth
 *   routes are public, so it could otherwise do that at will until its `exp`.
 * - `failed` — the users row could not be read or written. Logged; the
 *   browser's cookie is cleared regardless.
 */
export type LogoutOutcome = 'revoked' | 'stale' | 'failed';

export interface LogoutDeps {
  userStore: Pick<UserStore, 'findByProviderUserId' | 'update'>;
  /** Told about the revocation, for consumers holding sessions open. */
  sessions?: Pick<SessionRevocation, 'announce'>;
  /** Entra refresh tokens (#965) — what `/renew` would redeem next. */
  refreshStore?: Pick<RefreshStore, 'forget'>;
}

/**
 * The server-side half of `POST /api/v1/auth/logout`, for a cookie whose
 * signature verified. Never throws: sign-out must always clear the cookie.
 *
 * Sign-out ends every session of the user, not only this browser's: the
 * revocation marker is per user (`users.session_version`). A per-device
 * sign-out would need a denylist keyed by the token's `sid`.
 */
export async function endSessionsOnLogout(
  deps: LogoutDeps,
  session: VerifiedSession,
): Promise<LogoutOutcome> {
  const outcome = await revokeIfCurrent(deps, session);
  // #965 — forgetting the Entra refresh token ends the IdP-side renewal
  // chain. Skipped for a stale cookie for the same reason as the version
  // bump: the token on file may belong to the user's CURRENT session.
  if (
    outcome !== 'stale' &&
    session.provider === ENTRA_PROVIDER_ID &&
    deps.refreshStore
  ) {
    try {
      await deps.refreshStore.forget(session.email);
    } catch (err) {
      console.error(
        '[auth] /logout: failed to forget the refresh token:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return outcome;
}

async function revokeIfCurrent(
  deps: LogoutDeps,
  session: VerifiedSession,
): Promise<LogoutOutcome> {
  try {
    const row = await deps.userStore.findByProviderUserId(
      session.provider,
      session.sub,
    );
    if (!row || !accountVouchesFor(row, session)) return 'stale';
    await deps.userStore.update(row.id, { revokeSessions: true });
    deps.sessions?.announce({ provider: session.provider, sub: session.sub });
    return 'revoked';
  } catch (err) {
    console.error(
      '[auth] /logout: could not end the sessions server-side:',
      err instanceof Error ? err.message : err,
    );
    return 'failed';
  }
}
