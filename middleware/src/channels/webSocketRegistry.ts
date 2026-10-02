import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import type { ChannelSocketHandler, ChannelSessionClaims } from '@omadia/channel-sdk';

import { evaluateSessionToken } from '../auth/requireAuth.js';
import type { SessionRevocation } from '../auth/sessionRevocation.js';
import type { EmailWhitelist } from '../auth/whitelist.js';

import { authenticateChannelSession } from './channelSessionAuth.js';
import {
  ChannelSessionTracker,
  MAX_TIMER_MS,
  WS_SESSION_CHECK_TIMEOUT_MS,
  WS_SESSION_FRAME_RECHECK_MS,
  WS_SESSION_RECHECK_MS,
  type SessionRevokeReason,
} from './channelSessionLifetime.js';
import {
  authenticateBeforeHandshake,
  rejectUpgrade as reject,
  type WebSocketAuthenticator,
} from './webSocketUpgradeAuth.js';

export type { WebSocketAuthResult, WebSocketAuthenticator } from './webSocketUpgradeAuth.js';
export {
  WS_CLOSE_SESSION_EXPIRED,
  WS_CLOSE_SESSION_FORBIDDEN,
  WS_CLOSE_TRY_AGAIN,
  WS_SESSION_CHECK_TIMEOUT_MS,
  WS_SESSION_FRAME_RECHECK_MS,
  WS_SESSION_RECHECK_MS,
} from './channelSessionLifetime.js';

/**
 * The process's WebSocket mount — the upgrade-level counterpart to
 * {@link ExpressRouteRegistry}. The registry is the ONLY `upgrade` listener in
 * the process and delegates each upgrade through a path → route table. A route
 * is one of two kinds:
 *
 * - **Channel routes** (`register`, reached by plugins only through
 *   `CoreApi.registerWebSocket`): session-cookie + Entra-whitelist auth, the
 *   {@link CHANNEL_WS_MAX_PAYLOAD_BYTES} frame cap, a transport-agnostic
 *   {@link ChannelSocket} (the SDK never imports `ws`), and the channel's
 *   `active` lifecycle — `deactivateChannel` rejects new upgrades (503) and
 *   closes the channel's live sockets.
 * - **Kernel routes** (`registerKernel`, kernel code only — never exposed on
 *   `CoreApi`): their own {@link WebSocketAuthenticator} with a deadline, a
 *   REQUIRED `maxPayload`, and the raw `ws` socket (ping/pong, binary frames,
 *   backpressure). They do not belong to any channel, so channel activation
 *   and deactivation never touch them. Custom authentication is therefore a
 *   kernel-only capability: a plugin cannot opt out of the session cookie.
 *
 * Auth happens BEFORE the handshake for both kinds: a rejected peer gets a raw
 * `401`/`403` and the socket is destroyed — no `101` is ever sent, so no
 * WebSocket is allocated for it. An authenticator that throws or misses its
 * deadline is an infrastructure failure, not a verdict on the credential: the
 * peer gets a raw `503` (still no `101` — it fails closed). An unregistered
 * path is a raw `404`. Handlers only ever see an authenticated socket plus its
 * verified principal.
 *
 * A channel socket then lives no longer than its session
 * (`channelSessionLifetime.ts`): closed with 4401 at the token's `exp`, with
 * 4403 when the session is revoked — at once when the revocation is announced
 * on this replica, otherwise before the socket's next frame is handled (a
 * frame needs a verdict at most {@link WS_SESSION_FRAME_RECHECK_MS} old) and,
 * for a socket that sends nothing, within {@link WS_SESSION_RECHECK_MS}. While
 * the session cannot be checked, frames are withheld from the handler, and an
 * upgrade whose verdict cannot be trusted closes with 1013 before its handler
 * runs. Kernel routes own their principal and therefore their lifetime: the
 * registry enforces none for them.
 *
 * Every accepted socket carries an `'error'` listener: `ws` emits `'error'` on
 * any protocol violation from the peer (including a frame above the route's
 * `maxPayload`, which it answers with close code 1009). Without a listener that
 * emit is an uncaught exception.
 */

/**
 * Default inbound frame cap for channel routes: 32 MiB (ws's own default is
 * 100 MiB). Sized against the largest frame the canvas channel treats as
 * valid, measured in ASCII: `canvas_list_put` is sanitized to 50 entries × a
 * 262_144-character tree (`omadia-ui-channel/src/protocol.ts`
 * `sanitizeCanvasList`) ≈ 12.5 MiB of ASCII (the limit counts UTF-16 code
 * units, not bytes), so the cap leaves ~2.5× headroom over that ASCII worst
 * case. The desktop client caps neither the slot count nor the tree size
 * before sending (the server trims after parsing). A maximal list of purely
 * 3-byte UTF-8 text (~37.5 MiB) would exceed the cap; real trees are a few KB.
 * A frame above the cap closes the socket with 1009.
 */
export const CHANNEL_WS_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Upper bound for any `maxPayload`. `ws` stores the cap as `maxPayload | 0` and
 * enforces it only when that is above 0, so 2^31 or more would silently mean
 * "unlimited".
 */
export const WS_MAX_PAYLOAD_LIMIT_BYTES = 2 ** 31 - 1;

/** Default deadline for a kernel route's authenticator. */
export const KERNEL_WS_AUTH_TIMEOUT_MS = 10_000;

/** Kernel-route handler: the raw `ws` socket plus the authenticated principal. */
export type KernelSocketHandler<TPrincipal> = (
  ws: WebSocket,
  req: IncomingMessage,
  principal: TPrincipal,
) => void;

/**
 * A kernel route authenticates with its own credential, so the registry cannot
 * tell when that credential stops being valid: unlike channel routes, a kernel
 * socket gets no expiry close and no revocation close. A route whose credential
 * can expire or be revoked must close its own sockets (and document how); the
 * satellite tunnel's API key and signed challenge are no exception.
 */
export interface KernelWebSocketRoute<TPrincipal> {
  authenticate: WebSocketAuthenticator<TPrincipal>;
  /**
   * Inbound frame cap in bytes. Required — a kernel route chooses it. A
   * positive integer no larger than {@link WS_MAX_PAYLOAD_LIMIT_BYTES}.
   */
  maxPayload: number;
  /**
   * Deadline for `authenticate`, in ms (default
   * {@link KERNEL_WS_AUTH_TIMEOUT_MS}). Without it a hung authenticator would
   * hold the raw upgraded socket open forever.
   */
  authTimeoutMs?: number;
  handler: KernelSocketHandler<TPrincipal>;
}

interface ChannelRoute {
  kind: 'channel';
  channelId: string;
  path: string;
  handler: ChannelSocketHandler;
}

interface KernelRoute {
  kind: 'kernel';
  path: string;
  authenticate: WebSocketAuthenticator<unknown>;
  authTimeoutMs: number;
  handler: KernelSocketHandler<unknown>;
  wss: WebSocketServer;
  live: Set<WebSocket>;
}

type SocketRoute = ChannelRoute | KernelRoute;

export interface WebSocketRegistryDeps {
  /**
   * Symmetric key the core mints session JWTs with — the exact value
   * `requireAuth` verifies against (`resolveSessionSigningKey`). Injected so
   * the registry reuses core auth rather than re-deriving identity.
   */
  signingKey: Uint8Array;
  /**
   * The Entra email whitelist `requireAuth` enforces. The WS upgrade mirrors
   * the HTTP authorization gate: an OIDC (`entra`) session whose email is no
   * longer whitelisted is rejected with 403. Without it a de-whitelisted user
   * would keep WS access until the cookie expires while HTTP returns 403.
   */
  whitelist: EmailWhitelist;
  /**
   * Server-side session revocation — the same guard `requireAuth` runs
   * (`auth/sessionRevocation.ts`). With it a channel upgrade whose session was
   * ended (sign-out, admin password reset, disable, delete) is refused with a
   * raw 401, and one whose account could not be read with a raw 503.
   *
   * It also ends sockets that are ALREADY open: `onRevoked` closes that user's
   * channel sockets at once (4403), and `check` runs again before a frame
   * whose verdict is too old and on the idle-socket sweep, which is what
   * reaches a revocation made on another replica (the announcement is
   * process-local). Optional so test harnesses without a users table keep the
   * signature-only verdict.
   */
  sessions?: SessionRevocation;
  /**
   * Inbound frame cap for channel routes, in bytes. Defaults to
   * {@link CHANNEL_WS_MAX_PAYLOAD_BYTES}; injectable so tests can use a small cap.
   */
  channelMaxPayloadBytes?: number;
  /**
   * Cadence of the live-session re-check for channel sockets, in ms. Defaults
   * to {@link WS_SESSION_RECHECK_MS}; injectable so tests can use a short one.
   * A positive integer that setTimeout honours.
   */
  channelSessionRecheckMs?: number;
  /**
   * Oldest session verdict an inbound channel frame may ride on, in ms
   * between the start of its check and the frame's arrival; an older one is
   * re-checked first while the frame waits. 0 checks every frame. Defaults to
   * {@link WS_SESSION_FRAME_RECHECK_MS}; production passes the env value
   * `WS_SESSION_FRAME_RECHECK_MS`.
   */
  channelFrameRecheckMs?: number;
  /**
   * Deadline for one session check of a live channel socket, in ms. Defaults
   * to {@link WS_SESSION_CHECK_TIMEOUT_MS}; injectable so tests can use a
   * short one. A positive integer that setTimeout honours.
   */
  channelSessionCheckTimeoutMs?: number;
}

export class WebSocketRegistry {
  private readonly routes = new Map<string, SocketRoute>();
  private readonly activeByChannel = new Map<string, boolean>();
  /** Shared by every channel route (one cap for all channels). */
  private readonly channelWss: WebSocketServer;
  /** Every live channel socket with its session: expiry, re-check, revocation. */
  private readonly channelSessions: ChannelSessionTracker;
  private attached = false;

  constructor(private readonly deps: WebSocketRegistryDeps) {
    const maxPayload = deps.channelMaxPayloadBytes ?? CHANNEL_WS_MAX_PAYLOAD_BYTES;
    assertBoundedInteger('channelMaxPayloadBytes', maxPayload, WS_MAX_PAYLOAD_LIMIT_BYTES);
    const recheckMs = deps.channelSessionRecheckMs ?? WS_SESSION_RECHECK_MS;
    assertBoundedInteger('channelSessionRecheckMs', recheckMs, MAX_TIMER_MS);
    const frameRecheckMs = deps.channelFrameRecheckMs ?? WS_SESSION_FRAME_RECHECK_MS;
    // 0 is allowed: it means "check before every frame".
    assertBoundedInteger('channelFrameRecheckMs', frameRecheckMs, MAX_TIMER_MS, 0);
    const checkTimeoutMs = deps.channelSessionCheckTimeoutMs ?? WS_SESSION_CHECK_TIMEOUT_MS;
    assertBoundedInteger('channelSessionCheckTimeoutMs', checkTimeoutMs, MAX_TIMER_MS);
    this.channelWss = createServer(maxPayload);
    this.channelSessions = new ChannelSessionTracker({
      evaluate: (token) => evaluateSessionToken(token, deps),
      recheckMs,
      frameRecheckMs,
      checkTimeoutMs,
      ...(deps.sessions ? { revocations: deps.sessions } : {}),
    });
  }

  /**
   * Register a WebSocket path for a channel. Re-registering the same path for
   * the same channel (re-activation) replaces the handler; a different channel
   * or a kernel route owning the path is a hard conflict.
   */
  register(channelId: string, path: string, handler: ChannelSocketHandler): void {
    const existing = this.routes.get(path);
    if (existing?.kind === 'kernel') {
      throw new Error(`websocket path '${path}' already owned by a kernel route`);
    }
    if (existing && existing.channelId !== channelId) {
      throw new Error(
        `websocket path '${path}' already owned by channel '${existing.channelId}'`,
      );
    }
    this.routes.set(path, { kind: 'channel', channelId, path, handler });
    this.activeByChannel.set(channelId, true);
    console.log(
      `[channels] websocket registered ${path} (channel=${channelId})`,
    );
  }

  /**
   * Register a kernel-owned WebSocket path with its own pre-handshake
   * authenticator and frame cap. Kernel-only: this is deliberately NOT exposed
   * on `CoreApi`, so plugins always get session-cookie auth. Independent of
   * every channel's lifecycle. Any existing owner of the path is a conflict.
   */
  registerKernel<TPrincipal>(path: string, route: KernelWebSocketRoute<TPrincipal>): void {
    const existing = this.routes.get(path);
    if (existing) {
      const owner =
        existing.kind === 'kernel' ? 'a kernel route' : `channel '${existing.channelId}'`;
      throw new Error(`websocket path '${path}' already owned by ${owner}`);
    }
    assertBoundedInteger('maxPayload', route.maxPayload, WS_MAX_PAYLOAD_LIMIT_BYTES);
    const authTimeoutMs = route.authTimeoutMs ?? KERNEL_WS_AUTH_TIMEOUT_MS;
    assertBoundedInteger('authTimeoutMs', authTimeoutMs, MAX_TIMER_MS);
    const { authenticate, handler } = route;
    this.routes.set(path, {
      kind: 'kernel',
      path,
      authenticate,
      authTimeoutMs,
      // The principal is produced by this route's own authenticator.
      handler: (ws, req, principal) => handler(ws, req, principal as TPrincipal),
      wss: createServer(route.maxPayload),
      live: new Set(),
    });
    console.log(
      `[channels] websocket registered ${path} (kernel, maxPayload=${route.maxPayload})`,
    );
  }

  /** Flip a channel's active flag. Typically called right after register. */
  setActive(channelId: string, active: boolean): void {
    this.activeByChannel.set(channelId, active);
  }

  /**
   * Reject new upgrades for this channel and close its live sockets. Kernel
   * routes are not channel-owned and are never touched here.
   */
  deactivateChannel(channelId: string): void {
    this.activeByChannel.set(channelId, false);
    this.channelSessions.closeChannel(channelId);
    console.log(`[channels] websocket deactivated (channel=${channelId})`);
  }

  /**
   * Close every live channel socket whose session matches, with 4403 and
   * `reason`; returns how many it closed. Revocations announced through
   * `sessions.onRevoked` already end up here; this is the lever for any other
   * kernel path that ends sessions. Kernel sockets are never touched.
   */
  closeSessions(
    match: (claims: ChannelSessionClaims) => boolean,
    reason?: SessionRevokeReason,
  ): number {
    return this.channelSessions.closeSessions(match, reason);
  }

  /**
   * Hook the HTTP server's `upgrade` event. Idempotent. Must be called once,
   * after `app.listen(...)` yields the `http.Server`. The registry is the
   * process's only `upgrade` listener: new WebSocket consumers register a
   * route here (channel or kernel) instead of adding a second listener, and
   * an upgrade to an unregistered path is rejected with 404.
   */
  attach(server: HttpServer): void {
    if (this.attached) return;
    this.attached = true;
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(req, socket, head).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[channels] websocket upgrade error:`, message);
        socket.destroy();
      });
    });
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const path = pathFromUrl(req.url);
    const route = path ? this.routes.get(path) : undefined;
    if (!route) {
      reject(socket, 404);
      return;
    }
    if (route.kind === 'channel') {
      await this.upgradeChannel(route, req, socket, head);
    } else {
      await this.upgradeKernel(route, req, socket, head);
    }
  }

  private async upgradeChannel(
    route: ChannelRoute,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!this.isChannelRouteLive(route)) {
      reject(socket, 503);
      return;
    }
    // Before the check: a revocation announced while it runs finds no socket
    // to close yet, so `accept` looks for one itself.
    const mark = this.channelSessions.mark();
    const auth = await authenticateBeforeHandshake(
      (r) => authenticateChannelSession(r, this.deps),
      req,
      socket,
      route.path,
    );
    if (!auth) return;
    // The channel may have been deactivated (or the path re-registered) while
    // the cookie was being verified: re-check before handing out a socket.
    if (!this.isChannelRouteLive(route)) {
      reject(socket, 503);
      return;
    }

    this.channelWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      trackSocket(ws, undefined, `${route.path} (channel=${route.channelId})`);
      const channelSocket = this.channelSessions.accept(
        ws,
        req,
        route.channelId,
        auth.principal,
        mark,
      );
      // Expired (or no `exp` at all, 4401), revoked on this replica (4403) or
      // possibly revoked (1013) while the upgrade was being checked: already
      // closed, and the handler never sees it.
      if (!channelSocket) return;
      route.handler(channelSocket, { ...auth.principal.claims });
    });
  }

  private isChannelRouteLive(route: ChannelRoute): boolean {
    return (
      this.activeByChannel.get(route.channelId) === true &&
      this.routes.get(route.path) === route
    );
  }

  private async upgradeKernel(
    route: KernelRoute,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const auth = await authenticateBeforeHandshake(
      route.authenticate,
      req,
      socket,
      route.path,
      route.authTimeoutMs,
    );
    if (!auth) return;

    route.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      trackSocket(ws, route.live, `${route.path} (kernel)`);
      route.handler(ws, req, auth.principal);
    });
  }
}

/** Track a live socket for its owner and make every peer error non-fatal. */
function trackSocket(ws: WebSocket, live: Set<WebSocket> | undefined, owner: string): void {
  live?.add(ws);
  ws.on('close', () => live?.delete(ws));
  // `ws` closes the socket itself (e.g. 1009 for an oversized frame) and then
  // emits 'error'; without this listener that emit would be uncaught.
  ws.on('error', (err: Error & { code?: string }) => {
    console.warn(
      `[channels] websocket peer error on ${owner}: ${err.code ?? 'ERR'} ${err.message}`,
    );
  });
}

function createServer(maxPayload: number): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload, clientTracking: false });
}

/** An integer in `min..max` (`min` 1 by default: a positive integer). */
function assertBoundedInteger(name: string, value: number, max: number, min = 1): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    const kind = min === 0 ? 'a non-negative integer' : 'a positive integer';
    throw new Error(`websocket ${name} must be ${kind} <= ${String(max)}, got ${String(value)}`);
  }
}

/** Strip the query string; the path is the routing key. */
function pathFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
