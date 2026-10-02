import type { IncomingMessage } from 'node:http';

import { WebSocket, type RawData } from 'ws';

import type { ChannelSessionClaims, ChannelSocket } from '@omadia/channel-sdk';

import type { SessionEvaluation } from '../auth/requireAuth.js';
import type { SessionRevocation } from '../auth/sessionRevocation.js';

import { withoutSessionCookie, type AuthenticatedChannelSession } from './channelSessionAuth.js';
import {
  RECENT_REVOCATIONS_KEPT,
  RevocationLog,
  WS_CLOSE_SESSION_EXPIRED,
  WS_CLOSE_SESSION_FORBIDDEN,
  WS_CLOSE_TRY_AGAIN,
  closeForRefusal,
  evaluateSafely,
  withDeadline,
  type SessionCloseReason,
  type UpgradeMark,
} from './channelSessionCheck.js';

export type { AuthenticatedChannelSession } from './channelSessionAuth.js';
export {
  RECENT_REVOCATIONS_KEPT,
  WS_CLOSE_SESSION_EXPIRED,
  WS_CLOSE_SESSION_FORBIDDEN,
  WS_CLOSE_TRY_AGAIN,
  type SessionCloseReason,
  type UpgradeMark,
} from './channelSessionCheck.js';

/**
 * Session lifetime of channel WebSockets: a socket stays authorised exactly as
 * long as the session that opened it. `WebSocketRegistry` authenticates the
 * upgrade; from then on this tracker owns every accepted channel socket.
 *
 * - **Expiry.** Each socket carries its token's `exp` and is closed with
 *   {@link WS_CLOSE_SESSION_EXPIRED} at that moment (a timer, re-armed past
 *   setTimeout's ceiling). A token without `exp`, or one that expired while
 *   the upgrade was being checked, is closed before the handler runs, and a
 *   frame received or sent after `exp` is dropped even if the timer is late.
 * - **Revocation, this replica.** `SessionRevocation.onRevoked` (sign-out,
 *   password reset, disable, delete) closes that user's sockets at once with
 *   {@link WS_CLOSE_SESSION_FORBIDDEN} — also a socket whose upgrade was
 *   still being checked when it was announced; with too many announcements
 *   during that check to tell, {@link WS_CLOSE_TRY_AGAIN} instead.
 * - **Revocation, every replica: the next frame.** An announcement is
 *   process-local, so every inbound frame is checked on its own: it reaches
 *   the handler only on a verdict whose check started at most
 *   `frameRecheckMs` ({@link WS_SESSION_FRAME_RECHECK_MS}) before the frame
 *   arrived — the upgrade's check counts. With an older verdict the frame
 *   waits, and every frame behind it, while `evaluateSessionToken` (the
 *   verdict path HTTP uses) runs again; the socket stops reading meanwhile
 *   (TCP backpressure, so the wait cannot grow a buffer). A revoked session
 *   or a de-whitelisted identity closes with 4403, a token that no longer
 *   verifies with 4401, and the waiting frames are dropped. Both moments come
 *   from a monotonic clock, so a wall-clock step cannot stretch the bound.
 * - **Idle sockets.** Every {@link WS_SESSION_RECHECK_MS} one sweep checks
 *   every live socket too, which bounds what a socket that sends nothing
 *   still receives (notification pushes).
 * - **No verdict, no frame.** A lookup that fails, throws or misses its
 *   deadline ({@link WS_SESSION_CHECK_TIMEOUT_MS}) is an outage, not a
 *   verdict: the socket stays open, still bounded by its expiry, but the
 *   frames waiting on that check are withheld from `onMessage` and handed to
 *   `onRefusedMessage` (HTTP answers 503), and the verdict before the outage
 *   no longer counts, so the next frame checks again. One check per socket
 *   runs at a time; the sweep and the frames share it.
 * - **After the close.** The handler's `onClose` fires at once, no further
 *   frame reaches it and its sends are dropped, even while the peer is still
 *   acknowledging the close.
 *
 * Handlers get the verified claims only: the token stays here (the re-check
 * needs it) and the session cookie is stripped from `socket.request.headers`.
 * A socket closed by its peer, by its handler or by channel deactivation
 * leaves no timer behind; the sweep timer runs only while a socket is live.
 */

/** Sweep cadence for idle sockets — the admin UI's session heartbeat (60 s). */
export const WS_SESSION_RECHECK_MS = 60_000;

/**
 * Default oldest verdict a frame may ride on: its check must have started at
 * most this long before the frame arrived (env `WS_SESSION_FRAME_RECHECK_MS`).
 */
export const WS_SESSION_FRAME_RECHECK_MS = 5_000;

/** Deadline for one session check of a live socket. */
export const WS_SESSION_CHECK_TIMEOUT_MS = 10_000;

/** Largest delay `setTimeout` honours (a larger one fires immediately). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Why `closeSessions` ends a session (both close with 4403). */
export type SessionRevokeReason = 'session revoked' | 'session forbidden';

export interface ChannelSessionTrackerDeps {
  /**
   * Re-evaluates a held token. The registry wires `evaluateSessionToken` with
   * its own deps, so a socket and an HTTP request can never disagree on
   * whether a session still stands.
   */
  evaluate(token: string): Promise<SessionEvaluation>;
  /** Cadence of the idle-socket sweep, in ms. */
  recheckMs: number;
  /**
   * Oldest verdict a frame may ride on, in ms between the start of its check
   * and the frame's arrival; 0 checks every frame. Default
   * {@link WS_SESSION_FRAME_RECHECK_MS}.
   */
  frameRecheckMs?: number;
  /** Deadline for one check, in ms. Default {@link WS_SESSION_CHECK_TIMEOUT_MS}. */
  checkTimeoutMs?: number;
  /** Push side of server-side revocation (optional, like the registry's). */
  revocations?: Pick<SessionRevocation, 'onRevoked'>;
  /** Monotonic ms clock for verdict and frame ages (default `performance.now`). */
  monotonicNow?: () => number;
}

/** What a check means for the frames waiting on it. */
type Verdict = 'ok' | 'unknown' | 'closed';

/** `verifiedAt` while no verdict stands: older than any frame. */
const NO_VERDICT = Number.NEGATIVE_INFINITY;

interface HeldFrame {
  readonly text: string;
  /** Arrival, on the monotonic clock (ms). */
  readonly at: number;
}

interface LiveSession {
  readonly ws: WebSocket;
  readonly channelId: string;
  readonly session: AuthenticatedChannelSession;
  readonly closeListeners: Array<() => void>;
  readonly messageListeners: Array<(data: string) => void>;
  readonly refusedListeners: Array<(data: string) => void>;
  /** Frames waiting for a verdict, oldest first. */
  readonly held: HeldFrame[];
  expiryTimer: NodeJS.Timeout | undefined;
  /** The check in flight; the sweep and the frames share it. */
  check: Promise<Verdict> | undefined;
  /** Monotonic start (ms) of the check behind the standing `ok`, or {@link NO_VERDICT}. */
  verifiedAt: number;
  draining: boolean;
  ended: boolean;
}

export class ChannelSessionTracker {
  private readonly live = new Map<WebSocket, LiveSession>();
  private readonly revocationLog = new RevocationLog();
  private readonly frameRecheckMs: number;
  private readonly checkTimeoutMs: number;
  private readonly monotonicNow: () => number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: ChannelSessionTrackerDeps) {
    this.frameRecheckMs = deps.frameRecheckMs ?? WS_SESSION_FRAME_RECHECK_MS;
    this.checkTimeoutMs = deps.checkTimeoutMs ?? WS_SESSION_CHECK_TIMEOUT_MS;
    this.monotonicNow = deps.monotonicNow ?? (() => performance.now());
    deps.revocations?.onRevoked((who) => {
      this.revocationLog.record(who);
      this.closeSessions(
        (claims) => claims.provider === who.provider && claims.subject === who.sub,
      );
    });
  }

  /**
   * Take right before an upgrade's session check starts, and hand to
   * `accept`: the upgrade verdict's age counts from here, and a revocation
   * announced while the check runs still reaches the socket.
   */
  mark(): UpgradeMark {
    return { revocations: this.revocationLog.announced, at: this.monotonicNow() };
  }

  /**
   * Take over an accepted socket. Returns the handler-facing socket, or
   * `undefined` when the session already ended — expired (4401), revoked on
   * this replica during the upgrade check (4403) or possibly so (1013); the
   * socket is then closed and the handler must not run.
   */
  accept(
    ws: WebSocket,
    req: IncomingMessage,
    channelId: string,
    session: AuthenticatedChannelSession,
    mark: UpgradeMark = this.mark(),
  ): ChannelSocket | undefined {
    const live: LiveSession = {
      ws,
      channelId,
      session: { ...session, claims: Object.freeze({ ...session.claims }) },
      closeListeners: [],
      messageListeners: [],
      refusedListeners: [],
      held: [],
      expiryTimer: undefined,
      check: undefined,
      verifiedAt: mark.at,
      draining: false,
      ended: false,
    };
    this.live.set(ws, live);
    ws.on('close', () => this.release(live));
    ws.on('message', (data: RawData) => this.receive(live, frameText(data)));
    this.armExpiry(live);
    const duringUpgrade = this.revocationLog.since(mark, live.session.claims);
    if (duringUpgrade === 'revoked') this.end(live, WS_CLOSE_SESSION_FORBIDDEN, 'session revoked');
    if (duringUpgrade === 'unknown') this.refuseUnverified(live);
    if (live.ended) return undefined;
    this.scheduleSweep();
    return this.wrap(live, req);
  }

  /**
   * Too many revocations during the upgrade check to rule this user's out: no
   * handler runs on that verdict — connection-time work and pushes need no
   * frame — and 1013 sends the client back through a fresh check.
   */
  private refuseUnverified(live: LiveSession): void {
    if (!this.end(live, WS_CLOSE_TRY_AGAIN, 'session unverified')) return;
    console.warn(
      `[channels] websocket upgrade closed with 1013: over ${String(RECENT_REVOCATIONS_KEPT)} revocations during its check (channel=${live.channelId})`,
    );
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

  /** Has `exp` passed? The wall clock decides: `exp` is wall-clock time. */
  private pastExpiry(live: LiveSession): boolean {
    return Date.now() >= live.session.expiresAt * 1000;
  }

  /** Close at `exp` even if the expiry timer runs late; true when it did. */
  private expired(live: LiveSession): boolean {
    if (!this.pastExpiry(live)) return false;
    this.end(live, WS_CLOSE_SESSION_EXPIRED, 'session expired');
    return true;
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

  /** Forget a session: stop its timer, drop it and its frames, tell the handler. */
  private release(live: LiveSession): void {
    if (live.ended) return;
    live.ended = true;
    if (live.expiryTimer !== undefined) clearTimeout(live.expiryTimer);
    live.expiryTimer = undefined;
    live.held.length = 0;
    // Paused for a check: read on, or the peer's close frame never arrives.
    if (live.ws.isPaused) live.ws.resume();
    this.live.delete(live.ws);
    if (this.live.size === 0) this.stopSweep();
    for (const listener of live.closeListeners.splice(0)) {
      notify(listener);
    }
  }

  private isOpen(live: LiveSession): boolean {
    return !live.ended && live.ws.readyState === WebSocket.OPEN;
  }

  /** An inbound frame: dropped once the session ended, otherwise queued for its verdict. */
  private receive(live: LiveSession, text: string): void {
    if (!this.isOpen(live) || this.expired(live)) return;
    live.held.push({ text, at: this.monotonicNow() });
    this.drain(live).catch((err: unknown) => {
      // Nothing in `drain` is expected to throw; never let it go unhandled.
      console.error(`[channels] websocket frame gate failed: ${describe(err)}`);
    });
  }

  /**
   * Hand the queued frames over, oldest first, each only on a verdict whose
   * check started at most `frameRecheckMs` before the frame arrived. One drain
   * per socket at a time, so no frame overtakes another; while the standing
   * verdict is recent enough it runs synchronously.
   */
  private async drain(live: LiveSession): Promise<void> {
    if (live.draining) return;
    live.draining = true;
    try {
      while (this.isOpen(live) && live.held.length > 0) {
        const next = live.held[0] as HeldFrame;
        if (live.verifiedAt < next.at - this.frameRecheckMs) {
          // Stop reading while frames wait: TCP backpressure, not a queue
          // that grows for as long as the check takes.
          live.ws.pause();
          let verdict: Verdict;
          try {
            verdict = await this.recheck(live);
          } finally {
            if (!live.ended) live.ws.resume();
          }
          // Unknown: withhold everything that waited. Closed: nothing is left.
          if (verdict === 'unknown') this.withhold(live);
          continue;
        }
        if (this.expired(live)) return;
        live.held.shift();
        deliver(live.messageListeners, next.text);
      }
    } finally {
      live.draining = false;
    }
  }

  /** No verdict: the waiting frames go to `onRefusedMessage`, never to `onMessage`. */
  private withhold(live: LiveSession): void {
    for (const frame of live.held.splice(0)) deliver(live.refusedListeners, frame.text);
  }

  /** Run a session check, or join the one already running for this socket. */
  private recheck(live: LiveSession): Promise<Verdict> {
    if (live.check === undefined) {
      const check = this.runCheck(live).catch((err: unknown) => {
        console.error(`[channels] websocket session re-check failed: ${describe(err)}`);
        live.verifiedAt = NO_VERDICT;
        return 'unknown' as const;
      });
      live.check = check;
      // Registered before any caller awaits `check`, so it runs first.
      void check.then(() => {
        if (live.check === check) live.check = undefined;
      });
    }
    return live.check;
  }

  private async runCheck(live: LiveSession): Promise<Verdict> {
    const startedAt = this.monotonicNow();
    const evaluation = evaluateSafely((token) => this.deps.evaluate(token), live.session.token);
    const result = await withDeadline(evaluation, this.checkTimeoutMs);
    if (result === undefined) {
      console.warn(
        `[channels] websocket session re-check timed out after ${String(this.checkTimeoutMs)} ms (channel=${live.channelId})`,
      );
      // A refusal that still arrives ends the session all the same.
      void evaluation.then((late) => this.closeIfRefused(live, late));
    }
    if (live.ended) return 'closed';
    if (result?.ok === true) {
      live.verifiedAt = Math.max(live.verifiedAt, startedAt);
      return 'ok';
    }
    if (result !== undefined && this.closeIfRefused(live, result)) return 'closed';
    // An outage (failed lookup, throw, deadline): no frame rides on an
    // earlier verdict any more.
    live.verifiedAt = NO_VERDICT;
    return 'unknown';
  }

  /** End the session if `result` refuses it — an outage does not; true when it did. */
  private closeIfRefused(live: LiveSession, result: SessionEvaluation): boolean {
    if (result.ok || live.ended) return false;
    const close = closeForRefusal(result.code, live.session.expiresAt);
    if (close === undefined) return false;
    if (this.end(live, close.code, close.reason)) {
      console.log(
        `[channels] websocket session closed on re-check (channel=${live.channelId}, reason=${close.reason})`,
      );
    }
    return true;
  }

  private scheduleSweep(): void {
    if (this.sweepTimer !== undefined || this.live.size === 0) return;
    const timer = setTimeout(() => {
      this.sweepTimer = undefined;
      for (const live of [...this.live.values()]) {
        if (live.check === undefined) void this.recheck(live);
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

  private wrap(live: LiveSession, req: IncomingMessage): ChannelSocket {
    const { ws } = live;
    return {
      send: (data: string) => {
        if (live.ended) return;
        if (this.pastExpiry(live)) {
          // Outbound stops at `exp` like inbound, even with the timer late; the
          // close follows a microtask later, never inside the handler's `send`.
          queueMicrotask(() => this.expired(live));
          return;
        }
        ws.send(data);
      },
      onMessage: (cb: (data: string) => void) => {
        live.messageListeners.push(cb);
      },
      onRefusedMessage: (cb: (data: string) => void) => {
        live.refusedListeners.push(cb);
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

function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** Hand a frame to every listener; one that throws stops neither the rest nor the socket. */
function deliver(listeners: ReadonlyArray<(data: string) => void>, text: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(text);
    } catch (err) {
      console.error(`[channels] websocket message handler threw: ${describe(err)}`);
    }
  }
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
