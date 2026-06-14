import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket, type RawData } from 'ws';

import type {
  ChannelSocket,
  ChannelSocketHandler,
  ChannelSessionClaims,
} from '@omadia/channel-sdk';

import { SESSION_COOKIE } from '../auth/requireAuth.js';
import { verifySession } from '../auth/sessionJwt.js';
import type { EmailWhitelist } from '../auth/whitelist.js';

/** Heartbeat cadence — comfortably under the Fly edge proxy's ~60s idle-close. */
const WS_HEARTBEAT_MS = 30_000;

/**
 * Per-channel WebSocket mount — the upgrade-level counterpart to
 * {@link ExpressRouteRegistry}. The kernel owns the single `ws` server (in
 * `noServer` mode) and a path → channel registration table; channels reach
 * it only through `CoreApi.registerWebSocket`, never `ws` directly (the SDK
 * stays implementation-agnostic via {@link ChannelSocket}).
 *
 * Lifecycle mirrors the route registry: a per-channel `active` flag gates new
 * upgrades, and `deactivateChannel` both rejects new upgrades and closes the
 * channel's live sockets.
 *
 * Auth happens BEFORE the handshake: the upgrade carries the session cookie,
 * which is verified with the same signing key `requireAuth` uses. An
 * unauthenticated peer is rejected with a raw `401` and the socket destroyed —
 * no `101` is ever sent, so no WebSocket is allocated for it. The handler only
 * ever sees an authenticated socket plus its verified claims.
 */

interface RegisteredSocketRoute {
  channelId: string;
  path: string;
  handler: ChannelSocketHandler;
}

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
}

export class WebSocketRegistry {
  private readonly routes = new Map<string, RegisteredSocketRoute>();
  private readonly activeByChannel = new Map<string, boolean>();
  private readonly liveByChannel = new Map<string, Set<WebSocket>>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private attached = false;
  // WS keepalive: with no frames flowing, the Fly edge proxy closes an idle
  // canvas socket after ~60s of silence — the client then sees a mid-session
  // drop (reported while just typing a prompt). A standard ws ping/pong
  // heartbeat keeps frames flowing both ways AND reaps genuinely dead sockets.
  // Liveness is tracked off the ws object (WeakSet) to avoid type augmentation.
  private readonly aliveSockets = new WeakSet<WebSocket>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: WebSocketRegistryDeps) {}

  /**
   * Register a WebSocket path for a channel. Re-registering the same path for
   * the same channel (re-activation) replaces the handler; a different channel
   * claiming an owned path is a hard conflict.
   */
  register(channelId: string, path: string, handler: ChannelSocketHandler): void {
    const existing = this.routes.get(path);
    if (existing && existing.channelId !== channelId) {
      throw new Error(
        `websocket path '${path}' already owned by channel '${existing.channelId}'`,
      );
    }
    this.routes.set(path, { channelId, path, handler });
    this.activeByChannel.set(channelId, true);
    if (!this.liveByChannel.has(channelId)) {
      this.liveByChannel.set(channelId, new Set());
    }
    console.log(
      `[channels] websocket registered ${path} (channel=${channelId})`,
    );
  }

  /** Flip a channel's active flag. Typically called right after register. */
  setActive(channelId: string, active: boolean): void {
    this.activeByChannel.set(channelId, active);
  }

  /** Reject new upgrades for this channel and close its live sockets. */
  deactivateChannel(channelId: string): void {
    this.activeByChannel.set(channelId, false);
    const live = this.liveByChannel.get(channelId);
    if (live) {
      for (const ws of live) {
        ws.close(1001, 'channel deactivated');
      }
      live.clear();
    }
    console.log(`[channels] websocket deactivated (channel=${channelId})`);
  }

  /**
   * Hook the HTTP server's `upgrade` event. Idempotent. Must be called once,
   * after `app.listen(...)` yields the `http.Server`. A single registry owns
   * the `upgrade` event for the process (no other subsystem consumes it).
   */
  attach(server: HttpServer): void {
    if (this.attached) return;
    this.attached = true;
    this.startHeartbeat();
    // SINGLE-OWNER INVARIANT: this registry is the process's only `upgrade`
    // consumer (no other subsystem hosts a WebSocket today). An upgrade to an
    // unregistered path is rejected with 404. A future second WS consumer must
    // turn this into a delegating/fallback chain rather than destroying every
    // unmatched socket.
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
      reject(socket, 404, 'Not Found');
      return;
    }
    if (!this.activeByChannel.get(route.channelId)) {
      reject(socket, 503, 'Service Unavailable');
      return;
    }

    // Authenticate BEFORE completing the handshake — no 101 for an
    // unauthenticated peer. The raw upgrade request has no cookie-parser
    // middleware in front of it, so parse the header by hand.
    let session: ChannelSessionClaims;
    try {
      const token = sessionTokenFromCookie(req.headers.cookie);
      if (!token) {
        reject(socket, 401, 'Unauthorized');
        return;
      }
      const verified = await verifySession(token, this.deps.signingKey);
      // Mirror requireAuth's provider gate: OIDC ('entra') identities must
      // stay whitelisted. Local sessions were status-checked at login, so the
      // gate applies only to 'entra' — exactly as requireAuth does.
      if (
        verified.provider === 'entra' &&
        !this.deps.whitelist.isAllowed(verified.email)
      ) {
        reject(socket, 403, 'Forbidden');
        return;
      }
      session = {
        subject: verified.sub,
        email: verified.email,
        displayName: verified.display_name,
        provider: verified.provider,
        ...(verified.omadia_user_id
          ? { omadiaUserId: verified.omadia_user_id }
          : {}),
      };
    } catch {
      reject(socket, 401, 'Unauthorized');
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const live = this.liveByChannel.get(route.channelId);
      live?.add(ws);
      // Keepalive bookkeeping: fresh socket is alive; every pong (the client's
      // ws auto-responds to our ping) re-arms it. The heartbeat tick pings and
      // reaps — see startHeartbeat().
      this.aliveSockets.add(ws);
      ws.on('pong', () => this.aliveSockets.add(ws));
      ws.on('close', () => {
        live?.delete(ws);
        this.aliveSockets.delete(ws);
      });
      route.handler(wrapSocket(ws, req), session);
    });
  }

  /** Single process-wide heartbeat: every WS_HEARTBEAT_MS, ping each live
   *  socket and terminate any that missed the previous round's pong. Keeps
   *  idle canvas sockets alive through the Fly proxy and reaps dead ones. */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => this.heartbeatTick(), WS_HEARTBEAT_MS);
    // Don't keep the event loop alive just for the heartbeat.
    this.heartbeat.unref?.();
  }

  /** One heartbeat round: ping each live socket, terminate any that missed
   *  the previous round's pong. Exposed for tests; the interval drives it in
   *  production. */
  heartbeatTick(): void {
    for (const live of this.liveByChannel.values()) {
      for (const ws of live) {
        if (!this.aliveSockets.has(ws)) {
          ws.terminate();
          continue;
        }
        this.aliveSockets.delete(ws);
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }
  }
}

/** Strip the query string; the path is the routing key. */
function pathFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Extract the session cookie value from a raw `Cookie` header. */
function sessionTokenFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Wrap a raw `ws` socket in the transport-agnostic SDK {@link ChannelSocket}. */
function wrapSocket(ws: WebSocket, req: IncomingMessage): ChannelSocket {
  return {
    send: (data: string) => ws.send(data),
    onMessage: (cb: (data: string) => void) =>
      ws.on('message', (data: RawData) => {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data).toString('utf8');
        cb(text);
      }),
    onClose: (cb: () => void) => ws.on('close', () => cb()),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    request: { url: req.url ?? '', headers: req.headers },
  };
}

/** Reject an upgrade pre-handshake: write a raw status line, then destroy. */
function reject(socket: Duplex, code: number, message: string): void {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
