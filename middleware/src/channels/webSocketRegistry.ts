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
 *   `CoreApi`): their own {@link WebSocketAuthenticator}, a REQUIRED
 *   `maxPayload`, and the raw `ws` socket (ping/pong, binary frames,
 *   backpressure). They do not belong to any channel, so channel activation
 *   and deactivation never touch them. Custom authentication is therefore a
 *   kernel-only capability: a plugin cannot opt out of the session cookie.
 *
 * Auth happens BEFORE the handshake for both kinds: a rejected peer gets a raw
 * `401`/`403` and the socket is destroyed — no `101` is ever sent, so no
 * WebSocket is allocated for it. An unregistered path is a raw `404`. Handlers
 * only ever see an authenticated socket plus its verified principal.
 *
 * Every accepted socket carries an `'error'` listener: `ws` emits `'error'` on
 * any protocol violation from the peer (including a frame above the route's
 * `maxPayload`, which it answers with close code 1009). Without a listener that
 * emit is an uncaught exception.
 */

/**
 * Default inbound frame cap for channel routes: 32 MiB (ws's own default is
 * 100 MiB). Derived from the largest frame the canvas channel accepts:
 * `canvas_list_put` is sanitized to 50 entries × a 262_144-character tree
 * (`omadia-ui-channel/src/protocol.ts` `sanitizeCanvasList`) ≈ 12.5 MiB of
 * ASCII (the limit counts UTF-16 code units, not bytes), so the cap leaves
 * ~2.5× headroom over that ASCII worst case. The desktop client caps neither
 * the slot count nor the tree size before sending (the server trims after
 * parsing). A maximal list of purely 3-byte UTF-8 text (~37.5 MiB) would
 * exceed the cap; real trees are a few KB. A frame above the cap closes the
 * socket with 1009.
 */
export const CHANNEL_WS_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** Outcome of a pre-handshake authenticator. */
export type WebSocketAuthResult<TPrincipal> =
  | { ok: true; principal: TPrincipal }
  /**
   * `message` is for the server log only; the status line always carries the
   * standard reason phrase, so it can never inject header bytes.
   */
  | { ok: false; status: 401 | 403; message?: string };

/**
 * Runs on the raw upgrade request BEFORE the handshake. Resolving `ok: false`
 * rejects the upgrade with that status; throwing rejects it with 401.
 */
export type WebSocketAuthenticator<TPrincipal> = (
  req: IncomingMessage,
) => Promise<WebSocketAuthResult<TPrincipal>>;

/** Kernel-route handler: the raw `ws` socket plus the authenticated principal. */
export type KernelSocketHandler<TPrincipal> = (
  ws: WebSocket,
  req: IncomingMessage,
  principal: TPrincipal,
) => void;

export interface KernelWebSocketRoute<TPrincipal> {
  authenticate: WebSocketAuthenticator<TPrincipal>;
  /** Inbound frame cap in bytes. Required — a kernel route chooses it. */
  maxPayload: number;
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
   * Inbound frame cap for channel routes, in bytes. Defaults to
   * {@link CHANNEL_WS_MAX_PAYLOAD_BYTES}; injectable so tests can use a small cap.
   */
  channelMaxPayloadBytes?: number;
}

type RejectStatus = 401 | 403 | 404 | 503;

const REASON_PHRASE: Readonly<Record<RejectStatus, string>> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};

export class WebSocketRegistry {
  private readonly routes = new Map<string, SocketRoute>();
  private readonly activeByChannel = new Map<string, boolean>();
  private readonly liveByChannel = new Map<string, Set<WebSocket>>();
  /** Shared by every channel route (one cap for all channels). */
  private readonly channelWss: WebSocketServer;
  private attached = false;

  constructor(private readonly deps: WebSocketRegistryDeps) {
    const maxPayload = deps.channelMaxPayloadBytes ?? CHANNEL_WS_MAX_PAYLOAD_BYTES;
    assertPositiveInteger('channelMaxPayloadBytes', maxPayload);
    this.channelWss = createServer(maxPayload);
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
    if (!this.liveByChannel.has(channelId)) {
      this.liveByChannel.set(channelId, new Set());
    }
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
    assertPositiveInteger('maxPayload', route.maxPayload);
    const { authenticate, handler } = route;
    this.routes.set(path, {
      kind: 'kernel',
      path,
      authenticate,
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
    if (!this.activeByChannel.get(route.channelId)) {
      reject(socket, 503);
      return;
    }
    const session = await authenticateBeforeHandshake(
      (r) => this.authenticateSession(r),
      req,
      socket,
      route.path,
    );
    if (!session) return;

    this.channelWss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const live = this.liveByChannel.get(route.channelId);
      trackSocket(ws, live, `${route.path} (channel=${route.channelId})`);
      route.handler(wrapSocket(ws, req), session.principal);
    });
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
    );
    if (!auth) return;

    route.wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      trackSocket(ws, route.live, `${route.path} (kernel)`);
      route.handler(ws, req, auth.principal);
    });
  }

  /**
   * The channel-route authenticator: the session cookie verified with the
   * same signing key `requireAuth` uses, plus requireAuth's Entra whitelist
   * gate. The raw upgrade request has no cookie-parser middleware in front of
   * it, so the header is parsed by hand.
   */
  private async authenticateSession(
    req: IncomingMessage,
  ): Promise<WebSocketAuthResult<ChannelSessionClaims>> {
    const token = sessionTokenFromCookie(req.headers.cookie);
    if (!token) return { ok: false, status: 401 };
    let verified: Awaited<ReturnType<typeof verifySession>>;
    try {
      verified = await verifySession(token, this.deps.signingKey);
    } catch {
      return { ok: false, status: 401 };
    }
    // Mirror requireAuth's provider gate: OIDC ('entra') identities must stay
    // whitelisted. Local sessions were status-checked at login, so the gate
    // applies only to 'entra' — exactly as requireAuth does.
    if (verified.provider === 'entra' && !this.deps.whitelist.isAllowed(verified.email)) {
      return { ok: false, status: 403 };
    }
    return {
      ok: true,
      principal: {
        subject: verified.sub,
        email: verified.email,
        displayName: verified.display_name,
        provider: verified.provider,
        ...(verified.omadia_user_id ? { omadiaUserId: verified.omadia_user_id } : {}),
      },
    };
  }
}

/**
 * Run an authenticator against the raw upgrade request. Returns the principal
 * on success; otherwise writes the raw rejection (no 101) and returns
 * `undefined`. A throwing authenticator fails closed with 401.
 */
async function authenticateBeforeHandshake<TPrincipal>(
  authenticate: WebSocketAuthenticator<TPrincipal>,
  req: IncomingMessage,
  socket: Duplex,
  path: string,
): Promise<{ principal: TPrincipal } | undefined> {
  // Node removes its own socket error handler before emitting `upgrade`; guard
  // the auth window so a peer resetting mid-auth can't raise an uncaught error.
  const onEarlyError = (): void => undefined;
  socket.on('error', onEarlyError);
  let result: WebSocketAuthResult<TPrincipal>;
  try {
    result = await authenticate(req);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[channels] websocket authenticator threw on ${path}: ${message}`);
    result = { ok: false, status: 401 };
  } finally {
    socket.removeListener('error', onEarlyError);
  }
  if (result.ok) return { principal: result.principal };
  // Fail closed on anything but an explicit 403 (a JS caller could return junk).
  const status = result.status === 403 ? 403 : 401;
  if (result.message) {
    // JSON-quoted: an authenticator-supplied reason must not forge log lines.
    console.warn(
      `[channels] websocket upgrade rejected on ${path} (${status}): ${JSON.stringify(result.message)}`,
    );
  }
  reject(socket, status);
  return undefined;
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

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`websocket ${name} must be a positive integer, got ${String(value)}`);
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
function reject(socket: Duplex, code: RejectStatus): void {
  socket.write(`HTTP/1.1 ${code} ${REASON_PHRASE[code]}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
