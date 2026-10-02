import type { ChannelSessionClaims } from '@omadia/channel-sdk';

import type { SessionEvaluation, SessionFailureCode } from '../auth/requireAuth.js';
import {
  SESSION_CHECK_UNAVAILABLE_CODE,
  SESSION_REVOKED_CODE,
  type RevokedPrincipal,
} from '../auth/sessionRevocation.js';

/**
 * Verdicts on the session behind a live channel WebSocket: how a refusal maps
 * to a close code, how long one check may take, and which revocations an
 * upgrade still being checked has to hear about. `ChannelSessionTracker`
 * (`channelSessionLifetime.ts`) applies them.
 */

/**
 * The session expired or its token no longer verifies — the WebSocket twin of
 * HTTP 401. The client re-authenticates (renew or sign in), then reconnects.
 */
export const WS_CLOSE_SESSION_EXPIRED = 4401;

/**
 * The session was revoked or the identity is no longer authorised (the twin
 * of HTTP 403). Reconnecting with the same session can only be refused; the
 * user has to sign in again, which may itself be refused.
 */
export const WS_CLOSE_SESSION_FORBIDDEN = 4403;

/**
 * The upgrade's verdict cannot be trusted: more revocations were announced
 * while it ran than this replica keeps, so this user's may be among them.
 * Not a verdict on the session — 1013 is "Try Again Later", and the client's
 * reconnect goes through a fresh upgrade check.
 */
export const WS_CLOSE_TRY_AGAIN = 1013;

export type SessionCloseReason =
  | 'session expired'
  | 'session invalid'
  | 'session revoked'
  | 'session forbidden'
  | 'session unverified';

/** Announced revocations kept for upgrades whose session check still runs. */
export const RECENT_REVOCATIONS_KEPT = 256;

/**
 * How a refused check ends a socket: revoked and de-whitelisted sessions with
 * 4403, a token that no longer verifies with 4401 ("session expired" once
 * `exp` has passed — the re-check may land just before the expiry timer).
 * `undefined` for an outage: that is not a verdict on the session.
 */
export function closeForRefusal(
  code: SessionFailureCode,
  expiresAt: number,
  nowMs: number = Date.now(),
): { code: number; reason: SessionCloseReason } | undefined {
  if (code === SESSION_CHECK_UNAVAILABLE_CODE) return undefined;
  if (code === SESSION_REVOKED_CODE) {
    return { code: WS_CLOSE_SESSION_FORBIDDEN, reason: 'session revoked' };
  }
  if (code === 'auth.not_whitelisted') {
    return { code: WS_CLOSE_SESSION_FORBIDDEN, reason: 'session forbidden' };
  }
  const expired = expiresAt * 1000 <= nowMs;
  return { code: WS_CLOSE_SESSION_EXPIRED, reason: expired ? 'session expired' : 'session invalid' };
}

/**
 * Run `evaluate`, reading a throw (synchronous or not) as the outage it is.
 * `evaluateSessionToken` itself never throws — a failed lookup is its own
 * `auth.unavailable` verdict — so this only guards other implementations.
 */
export async function evaluateSafely(
  evaluate: (token: string) => Promise<SessionEvaluation>,
  token: string,
): Promise<SessionEvaluation> {
  try {
    return await evaluate(token);
  } catch (err) {
    console.error(
      `[channels] websocket session re-check threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, code: SESSION_CHECK_UNAVAILABLE_CODE, message: 'session check failed' };
  }
}

/** Resolve with `pending`'s value, or with `undefined` once `ms` pass first. */
export async function withDeadline<T>(pending: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Taken right before an upgrade's session check starts. */
export interface UpgradeMark {
  /** How many revocations this replica had announced at that moment. */
  readonly revocations: number;
  /**
   * When the check started, on the tracker's monotonic clock (ms): the
   * upgrade verdict's age counts from here.
   */
  readonly at: number;
}

/**
 * The revocations announced on this replica, so an upgrade can learn about
 * one that landed while its own session check was running. Such an
 * announcement finds no socket to close yet: the upgrade read the account
 * just before the revocation and would otherwise hand a revoked socket to its
 * handler.
 */
export class RevocationLog {
  private count = 0;
  private readonly recent: Array<{ readonly seq: number; readonly key: string }> = [];

  record(who: RevokedPrincipal): void {
    this.count += 1;
    this.recent.push({ seq: this.count, key: principalKey(who.provider, who.sub) });
    if (this.recent.length > RECENT_REVOCATIONS_KEPT) this.recent.shift();
  }

  /** How many revocations this replica has announced so far. */
  get announced(): number {
    return this.count;
  }

  /**
   * Were this user's sessions revoked here since `mark`? `unknown` when more
   * revocations arrived meanwhile than the log keeps.
   */
  since(
    mark: Pick<UpgradeMark, 'revocations'>,
    claims: Pick<ChannelSessionClaims, 'provider' | 'subject'>,
  ): 'revoked' | 'clear' | 'unknown' {
    if (this.count === mark.revocations) return 'clear';
    const key = principalKey(claims.provider, claims.subject);
    if (this.recent.some((r) => r.seq > mark.revocations && r.key === key)) return 'revoked';
    const oldest = this.recent[0]?.seq ?? Number.POSITIVE_INFINITY;
    return oldest > mark.revocations + 1 ? 'unknown' : 'clear';
  }
}

/** Unambiguous for any provider id and subject. */
function principalKey(provider: string, sub: string): string {
  return JSON.stringify([provider, sub]);
}
