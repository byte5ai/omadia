import type { UserRecord } from './userStore.js';

/**
 * Server-side session revocation.
 *
 * The admin session is a stateless JWT, so on its own nothing on the server
 * can end one early. This module is the primitive that can: every token
 * carries the account's `users.session_version` at mint time (claim `sv`) and
 * the `users.id` it was minted for (claim `uid`), and a session stands only
 * while that row still exists, is `active`, is the same row, and still has the
 * same version. Moving the version (`UserStore.update(id, { revokeSessions:
 * true })`) ends every outstanding session of that user at once, on every
 * consumer — the check sits inside `evaluateSessionToken`, which `requireAuth`,
 * `ctx.operatorAuth`, the channel WebSocket upgrade and `/renew` all share.
 *
 * Who moves it: sign-out (`POST /api/v1/auth/logout`, every device of that
 * user), an admin password reset and disabling the account. Deleting the row
 * needs no bump — a missing row is itself the revocation, and the `uid` claim
 * keeps a re-created row (new id, version 0 again) from reviving old cookies.
 *
 * No cache: every check is one indexed point read, so "revoked" is effective
 * on the very next request, on every replica.
 */

/** Refusal code for a session whose account no longer vouches for it. */
export const SESSION_REVOKED_CODE = 'auth.revoked';

/**
 * Refusal code for a session that could not be checked because the account
 * lookup failed (database unreachable, query timeout). An outage, never a
 * verdict on the credential: HTTP callers answer 503 so the UI keeps the
 * operator signed in and retries, instead of bouncing everyone to /login.
 */
export const SESSION_CHECK_UNAVAILABLE_CODE = 'auth.unavailable';

/** The claims a revocation check reads. A verified session token has them all. */
export interface SessionIdentity {
  /** Provider the session was minted by (`local`, `entra`, …). */
  provider: string;
  /** Provider-internal user id — `users.provider_user_id`. */
  sub: string;
  /** `users.session_version` at mint time (0 for a token older than the claim). */
  sv: number;
  /** `users.id` at mint time; absent on a token older than the claim. */
  uid?: string;
}

/** The users-row fields that decide whether a session still stands. */
export type SessionAccount = Pick<UserRecord, 'id' | 'status' | 'sessionVersion'>;

/**
 * `ok` — the account still vouches for the session. `revoked` — it does not
 * (row gone, disabled, re-created, or version moved on). `unavailable` — the
 * account could not be read; fail closed, but report it as an outage.
 */
export type SessionVerdict = 'ok' | 'revoked' | 'unavailable';

/** Whose sessions just ended — the payload of {@link SessionRevocation.announce}. */
export interface RevokedPrincipal {
  provider: string;
  sub: string;
}

export type RevocationListener = (who: RevokedPrincipal) => void;

/** Where the guard reads accounts from. `UserStore` satisfies it. */
export interface SessionAccountSource {
  findByProviderUserId(
    provider: string,
    providerUserId: string,
  ): Promise<SessionAccount | null>;
}

/**
 * The revocation contract every session consumer depends on.
 *
 * - `check` is the verdict for one session. It never throws: a failed lookup
 *   is `unavailable`.
 * - `announce` never throws either — the route that just revoked must not
 *   fail because a listener did.
 * - `announce` / `onRevoked` are the push side, for consumers that hold a
 *   session open after authenticating it once (live WebSockets, SSE streams):
 *   a route that just revoked a user's sessions announces it, and a listener
 *   can close what that user still holds open. The announcement is
 *   PROCESS-LOCAL — a revocation on another replica, or one made directly in
 *   SQL, is never announced here — so a long-lived consumer must also re-run
 *   `check` for what it holds (it is cross-replica exact); the announcement
 *   only makes the common case immediate.
 */
export interface SessionRevocation {
  check(session: SessionIdentity): Promise<SessionVerdict>;
  announce(who: RevokedPrincipal): void;
  onRevoked(listener: RevocationListener): () => void;
}

/**
 * Does this users row still vouch for this session? Pure — the single rule,
 * shared by the guard, by `/logout` (which may only revoke on behalf of a
 * cookie that is itself still current) and by `/renew`'s identity re-check.
 */
export function accountVouchesFor(
  account: SessionAccount | null,
  session: SessionIdentity,
): boolean {
  // Deleted: the absence of the row is the revocation.
  if (!account) return false;
  // Disabled takes effect on the next request, not at the next renewal.
  if (account.status !== 'active') return false;
  // A different row under the same identity (deleted and re-created).
  if (session.uid !== undefined && session.uid !== account.id) return false;
  // Sign-out, password reset or disable moved the version on.
  return account.sessionVersion === session.sv;
}

/**
 * The kernel's {@link SessionRevocation}. Late-bound: `requireAuth` and
 * `ctx.operatorAuth` are built long before the Postgres pool that holds the
 * `users` table exists, so the account source is attached once it does
 * (`attach`, right after the `UserStore` is constructed and before the server
 * listens).
 *
 * Without an attached source every check is `ok`. That is the no-Postgres
 * mode: no `users` table, no login route mounted, so nothing can mint a
 * session to revoke — the boot log says so.
 */
export class SessionRevocationGuard implements SessionRevocation {
  private source: SessionAccountSource | undefined;
  private readonly listeners = new Set<RevocationListener>();

  constructor(
    private readonly log: (line: string) => void = (line) => {
      console.error(line);
    },
  ) {}

  /** Wire the account source. Called once at boot, after the users table exists. */
  attach(source: SessionAccountSource): void {
    this.source = source;
  }

  /** True once an account source is attached (i.e. revocation is enforced). */
  get isAttached(): boolean {
    return this.source !== undefined;
  }

  async check(session: SessionIdentity): Promise<SessionVerdict> {
    const source = this.source;
    if (!source) return 'ok';
    let account: SessionAccount | null;
    try {
      account = await source.findByProviderUserId(session.provider, session.sub);
    } catch (err) {
      // Provider only, never the sub — for local accounts that is an email.
      this.log(
        `[auth] session revocation lookup failed (provider=${session.provider}): ${describe(err)}`,
      );
      return 'unavailable';
    }
    return accountVouchesFor(account, session) ? 'ok' : 'revoked';
  }

  announce(who: RevokedPrincipal): void {
    // Iterate a snapshot: a listener may unsubscribe itself while being told.
    for (const listener of [...this.listeners]) {
      try {
        listener(who);
      } catch (err) {
        // One broken consumer must neither fail the route that revoked nor
        // keep the remaining listeners from hearing about it.
        this.log(`[auth] session revocation listener threw: ${describe(err)}`);
      }
    }
  }

  onRevoked(listener: RevocationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
