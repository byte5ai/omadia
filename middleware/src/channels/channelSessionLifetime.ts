import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import { WebSocket, type RawData } from 'ws';

import type { ChannelSessionClaims, ChannelSocket } from '@omadia/channel-sdk';

import {
  SESSION_COOKIE,
  type SessionEvaluation,
  type SessionFailureCode,
} from '../auth/requireAuth.js';
import {
  SESSION_CHECK_UNAVAILABLE_CODE,
  SESSION_REVOKED_CODE,
  type SessionRevocation,
} from '../auth/sessionRevocation.js';

/**
 * Session lifetime of channel WebSockets: a socket stays authorised exactly as
 * long as the session that opened it. `WebSocketRegistry` authenticates the
 * upgrade; from then on this tracker owns every accepted channel socket.
 *
 * - **Expiry.** Each socket carries its token's `exp` and is closed with
 *   {@link WS_CLOSE_SESSION_EXPIRED} at that moment (a timer, re-armed past
 *   setTimeout's ceiling). A token without `exp`, or one that expired while
 *   the upgrade was being checked, is closed before the handler runs, and a
 *   frame that arrives after `exp` is dropped even if the timer is late.
 * - **Revocation, this replica.** `SessionRevocation.onRevoked` (sign-out,
 *   password reset, disable, delete) closes that user's sockets at once with
 *   {@link WS_CLOSE_SESSION_FORBIDDEN}.
 * - **Revocation, every replica.** An announcement is process-local, so every
 *   {@link WS_SESSION_RECHECK_MS} one sweep re-runs `evaluateSessionToken` —
 *   the verdict path HTTP uses — for every live socket. A revoked session or
 *   a de-whitelisted identity closes with 4403, a token that no longer
 *   verifies with 4401. A failed account lookup is an outage, not a verdict:
 *   the socket stays, still bounded by its expiry. A slow check is never
 *   started twice for the same socket.
 * - **After the close.** The handler's `onClose` fires at once, no further
 *   frame reaches it and its sends are dropped, even while the peer is still
 *   acknowledging the close.
 *
 * Handlers get the verified claims only: the token stays here (the re-check
 * needs it) and the session cookie is stripped from `socket.request.headers`.
 * A socket closed by its peer, by its handler or by channel deactivation
 * leaves no timer behind; the sweep timer runs only while a socket is live.
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

/** Re-check cadence — the same as the admin UI's session heartbeat (60 s). */
export const WS_SESSION_RECHECK_MS = 60_000;

/** Largest delay `setTimeout` honours (a larger one fires immediately). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export type SessionCloseReason =
  | 'session expired'
  | 'session invalid'
  | 'session revoked'
  | 'session forbidden';

/** Why `closeSessions` ends a session (both close with 4403). */
export type SessionRevokeReason = 'session revoked' | 'session forbidden';

/**
 * An authenticated channel session as the registry holds it. The raw token
 * never leaves the registry; a handler only ever gets `claims`.
 */
export interface AuthenticatedChannelSession {
  readonly claims: ChannelSessionClaims;
  readonly token: string;
  /** Token `exp`, Unix epoch seconds; 0 for a token without one. */
  readonly expiresAt: number;
}

export interface ChannelSessionTrackerDeps {
  /**
   * Re-evaluates a held token. The registry wires `evaluateSessionToken` with
   * its own deps, so a socket and an HTTP request can never disagree on
   * whether a session still stands.
   */
  evaluate(token: string): Promise<SessionEvaluation>;
  /** Cadence of the periodic re-check, in ms. */
  recheckMs: number;
  /** Push side of server-side revocation (optional, like the registry's). */
  revocations?: Pick<SessionRevocation, 'onRevoked'>;
}

interface LiveSession {
  readonly ws: WebSocket;
  readonly channelId: string;
  readonly session: AuthenticatedChannelSession;
  readonly closeListeners: Array<() => void>;
  expiryTimer: NodeJS.Timeout | undefined;
  checking: boolean;
  ended: boolean;
}

export class ChannelSessionTracker {
  private readonly live = new Map<WebSocket, LiveSession>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: ChannelSessionTrackerDeps) {
    deps.revocations?.onRevoked((who) => {
      this.closeSessions(
        (claims) => claims.provider === who.provider && claims.subject === who.sub,
      );
    });
  }

  /**
   * Take over an accepted socket. Returns the handler-facing socket, or
   * `undefined` when the session has already expired — the socket is then
   * closed with 4401 and the handler must not run.
   */
  accept(
    ws: WebSocket,
    req: IncomingMessage,
    channelId: string,
    session: AuthenticatedChannelSession,
  ): ChannelSocket | undefined {
    const live: LiveSession = {
      ws,
      channelId,
      session: { ...session, claims: Object.freeze({ ...session.claims }) },
      closeListeners: [],
      expiryTimer: undefined,
      checking: false,
      ended: false,
    };
    this.live.set(ws, live);
    ws.on('close', () => this.release(live));
    this.armExpiry(live);
    if (live.ended) return undefined;
    this.scheduleSweep();
    return this.wrap(live, req);
  }

  /**
   * Close every live socket whose session matches with 4403. Returns how many
   * it closed; a socket that is already closing is not counted.
   */
  closeSessions(
    match: (claims: ChannelSessionClaims) => boolean,
    reason: SessionRevokeReason = 'session revoked',
  ): number {
    let closed = 0;
    for (const live of [...this.live.values()]) {
      if (!match(live.session.claims)) continue;
      if (this.end(live, WS_CLOSE_SESSION_FORBIDDEN, reason)) closed += 1;
    }
    if (closed > 0) {
      console.log(`[channels] websocket sessions closed (n=${String(closed)}, reason=${reason})`);
    }
    return closed;
  }

  /** Close a deactivated channel's sockets with 1001; returns how many. */
  closeChannel(channelId: string): number {
    let closed = 0;
    for (const live of [...this.live.values()]) {
      if (live.channelId !== channelId) continue;
      if (this.end(live, 1001, 'channel deactivated')) closed += 1;
    }
    return closed;
  }

  private armExpiry(live: LiveSession): void {
    if (live.ended) return;
    const remaining = live.session.expiresAt * 1000 - Date.now();
    if (!(remaining > 0)) {
      this.end(live, WS_CLOSE_SESSION_EXPIRED, 'session expired');
      return;
    }
    const timer = setTimeout(() => this.armExpiry(live), Math.min(remaining, MAX_TIMER_MS));
    timer.unref();
    live.expiryTimer = timer;
  }

  /**
   * End a session from the server side: close the socket first (so a handler
   * reacting to `onClose` cannot replace the close code), then release it.
   * Idempotent. True when this call closed an open socket.
   */
  private end(live: LiveSession, code: number, reason: SessionCloseReason | 'channel deactivated'): boolean {
    if (live.ended) return false;
    const open = live.ws.readyState === WebSocket.OPEN;
    if (open) live.ws.close(code, reason);
    this.release(live);
    return open;
  }

  /** Forget a session: stop its timer, drop it from the sweep, tell the handler. */
  private release(live: LiveSession): void {
    if (live.ended) return;
    live.ended = true;
    if (live.expiryTimer !== undefined) clearTimeout(live.expiryTimer);
    live.expiryTimer = undefined;
    this.live.delete(live.ws);
    if (this.live.size === 0) this.stopSweep();
    for (const listener of live.closeListeners.splice(0)) {
      notify(listener);
    }
  }

  /** Whether an inbound frame may reach the handler right now. */
  private admits(live: LiveSession): boolean {
    if (live.ended || live.ws.readyState !== WebSocket.OPEN) return false;
    if (Date.now() >= live.session.expiresAt * 1000) {
      this.end(live, WS_CLOSE_SESSION_EXPIRED, 'session expired');
      return false;
    }
    return true;
  }

  private scheduleSweep(): void {
    if (this.sweepTimer !== undefined || this.live.size === 0) return;
    const timer = setTimeout(() => {
      this.sweepTimer = undefined;
      for (const live of [...this.live.values()]) {
        if (!live.checking) void this.recheck(live);
      }
      this.scheduleSweep();
    }, this.deps.recheckMs);
    timer.unref();
    this.sweepTimer = timer;
  }

  private stopSweep(): void {
    if (this.sweepTimer === undefined) return;
    clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private async recheck(live: LiveSession): Promise<void> {
    live.checking = true;
    let result: SessionEvaluation;
    try {
      result = await this.deps.evaluate(live.session.token);
    } catch (err) {
      // `evaluateSessionToken` does not throw — a failed lookup is its own
      // `auth.unavailable` verdict. Anything else that does is an outage too.
      console.error(`[channels] websocket session re-check threw: ${describe(err)}`);
      return;
    } finally {
      live.checking = false;
    }
    if (result.ok || live.ended) return;
    const close = closeForRefusal(result.code, live.session.expiresAt);
    if (close && this.end(live, close.code, close.reason)) {
      console.log(
        `[channels] websocket session closed on re-check (channel=${live.channelId}, reason=${close.reason})`,
      );
    }
  }

  private wrap(live: LiveSession, req: IncomingMessage): ChannelSocket {
    const { ws } = live;
    return {
      send: (data: string) => {
        if (!live.ended) ws.send(data);
      },
      onMessage: (cb: (data: string) => void) => {
        ws.on('message', (data: RawData) => {
          if (this.admits(live)) cb(frameText(data));
        });
      },
      onClose: (cb: () => void) => {
        if (live.ended) {
          queueMicrotask(() => notify(cb));
          return;
        }
        live.closeListeners.push(cb);
      },
      close: (code?: number, reason?: string) => ws.close(code, reason),
      request: { url: req.url ?? '', headers: withoutSessionCookie(req.headers) },
    };
  }
}

/**
 * How a refused re-check ends a socket: revoked and de-whitelisted sessions
 * with 4403, a token that no longer verifies with 4401 ("session expired" once
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
 * The upgrade request's headers minus the session cookie, for handlers: they
 * get the verified claims, never the token. Other cookies pass through.
 */
export function withoutSessionCookie(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const { cookie, ...rest } = headers;
  if (cookie === undefined) return rest;
  const kept = cookie
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0 && cookieName(pair) !== SESSION_COOKIE);
  return kept.length > 0 ? { ...rest, cookie: kept.join('; ') } : rest;
}

function cookieName(pair: string): string {
  const eq = pair.indexOf('=');
  return (eq === -1 ? pair : pair.slice(0, eq)).trim();
}

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Run a handler's close listener; one that throws must not break the rest. */
function notify(listener: () => void): void {
  try {
    listener();
  } catch (err) {
    console.error(`[channels] websocket close handler threw: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
