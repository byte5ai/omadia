import type { ConnectionStatus } from './connection.js';
import {
  parseServerMessage,
  type ClientCanvasListGet,
  type ClientTurn,
  type ServerMessage,
} from './protocol.js';
import { createHandshake } from './handshake.js';

export interface SessionPersistence {
  load(): string | undefined;
  save(canvasSessionId: string): void;
}

/** Minimal standard-WebSocket surface — satisfied by React Native's global
 *  WebSocket, browser WebSocket, and the `ws` package alike. The core never
 *  imports a platform WebSocket; hosts inject a factory. */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
}

export type WebSocketFactory = (url: string, headers?: Record<string, string>) => WsLike;

const WS_OPEN = 1; // WebSocket.OPEN, identical across all implementations

/** Close code: the session behind the socket expired (or no longer verifies).
 *  Renew or sign in again, then `connect()`; the socket does not retry alone. */
export const CLOSE_SESSION_EXPIRED = 4401;
/** Close code: the session was revoked or the identity is no longer authorised.
 *  Terminal; only a fresh sign-in and `connect()` start over. */
export const CLOSE_SESSION_FORBIDDEN = 4403;

/** The `omadia_session=…` header value, or a function returning the current
 *  one. The function form is read on every (re)connect, so a cookie the host
 *  renewed or replaced after a sign-in is picked up by the next `connect()`. */
export type CookieSource = string | (() => string | undefined);

export interface CanvasSocketOptions {
  url: string;
  /** Session cookie for hosts that set the header themselves (Node, Electron,
   *  React Native). Omit for the stub server and in browsers, which attach
   *  the cookie on their own. */
  cookie?: CookieSource;
  localOperations: string[];
  session: SessionPersistence;
  createWebSocket: WebSocketFactory;
  onMessage: (msg: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
}

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000] as const;

/**
 * Owns the WebSocket to omadia-ui-channel: handshake on every (re)connect,
 * exponential-backoff reconnect, canvasSessionId persistence across sessions.
 * Resync (surfaceSeq gap / revision mismatch) = reconnect + re-select with the
 * same canvasSessionId — the v1 snapshot-re-request mechanism (protocol §5.1).
 *
 * The server ends a socket with its session: 4401 at expiry, 4403 on
 * revocation. Neither is retried with backoff — the same cookie would only be
 * refused — so the socket reports `unauthenticated` / `forbidden` and waits
 * for the host to re-authenticate and call `connect()` again. The `ready`
 * status carries `sessionExpiresAt` so the host can warn the user in time.
 */
export class CanvasSocket {
  private ws: WsLike | null = null;
  private ready = false;
  private closedByUser = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeOverride: string | undefined;
  private switching = false;

  constructor(private readonly opts: CanvasSocketOptions) {}

  /** Open the socket — also the way back after `unauthenticated` or
   *  `forbidden`, once the host has a valid session again. */
  connect(): void {
    this.closedByUser = false;
    // A reconnect already scheduled by the backoff would open a second socket.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.open();
  }

  sendTurn(turn: ClientTurn): void {
    if (this.ready && this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(turn));
    } else {
      this.opts.onStatus({ state: 'failed', detail: 'turn dropped: socket not ready' });
    }
  }

  requestCanvasList(): void {
    if (!this.ready || this.ws?.readyState !== WS_OPEN) {
      return;
    }
    const request = { type: 'canvas_list_get' } satisfies ClientCanvasListGet;
    this.ws.send(JSON.stringify(request));
  }

  /** Tear down and re-handshake with the persisted canvasSessionId. */
  resync(): void {
    this.ws?.close(4000, 'client resync');
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.switching = false;
    this.ws?.close(1000, 'client shutdown');
  }

  switchCanvas(sessionId: string): void {
    this.resumeOverride = sessionId;
    this.closedByUser = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.switching = true;
    this.ws?.close(4001, 'client canvas switch');
    this.open();
  }

  private open(): void {
    this.ready = false;
    this.opts.onStatus({ state: 'connecting' });
    const cookie = typeof this.opts.cookie === 'function' ? this.opts.cookie() : this.opts.cookie;
    const headers = cookie ? { Cookie: cookie } : undefined;
    const ws = this.opts.createWebSocket(this.opts.url, headers);
    this.ws = ws;
    this.switching = false;

    const handshake = createHandshake({
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
      localOperations: this.opts.localOperations,
      canvasSessionId: this.resumeOverride ?? this.opts.session.load(),
    });

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const msg = parseServerMessage(String(ev.data));
      if (!msg) return;

      if (!this.ready) {
        const action = handshake.onMessage(msg);
        if (!action) return;
        if (action.kind === 'send') {
          ws.send(JSON.stringify(action.message));
        } else if (action.kind === 'ready') {
          this.ready = true;
          this.attempt = 0;
          this.resumeOverride = undefined;
          this.opts.session.save(action.canvasSessionId);
          this.opts.onStatus({
            state: 'ready',
            canvasSessionId: action.canvasSessionId,
            ...(action.sessionExpiresAt !== undefined
              ? { sessionExpiresAt: action.sessionExpiresAt }
              : {}),
          });
        } else {
          this.opts.onStatus({ state: 'failed', detail: action.reason });
          this.closedByUser = true; // version failure is terminal, not retryable
          ws.close(1002, action.reason);
        }
        return;
      }
      this.opts.onMessage(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ready = false;
      if (this.switching) {
        return;
      }
      if (this.closedByUser) {
        this.opts.onStatus({ state: 'disconnected' });
        return;
      }
      const { code, reason } = closeDetails(ev);
      if (code === CLOSE_SESSION_EXPIRED || code === CLOSE_SESSION_FORBIDDEN) {
        // The session ended, not the network: a retry with the same cookie
        // can only be refused. Stop until the host calls connect() again.
        this.closedByUser = true;
        const expired = code === CLOSE_SESSION_EXPIRED;
        this.opts.onStatus({
          state: expired ? 'unauthenticated' : 'forbidden',
          closeCode: code,
          detail: reason || (expired ? 'session expired' : 'session revoked'),
        });
        return;
      }
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] as number;
      this.attempt += 1;
      this.opts.onStatus({ state: 'connecting', detail: `reconnecting in ${delay}ms` });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.open();
      }, delay);
    };

    ws.onerror = (ev) => {
      if (this.ws !== ws) return;
      this.opts.onStatus({ state: 'failed', detail: ev.message ?? 'websocket error' });
      // 'close' follows and drives the backoff.
    };
  }
}

/** Code and reason of a close event — browser, React Native and `ws` all
 *  deliver a CloseEvent with both; anything else reads as "no code". */
function closeDetails(ev: unknown): { code: number | undefined; reason: string } {
  if (typeof ev !== 'object' || ev === null) return { code: undefined, reason: '' };
  const { code, reason } = ev as { code?: unknown; reason?: unknown };
  return {
    code: typeof code === 'number' ? code : undefined,
    reason: typeof reason === 'string' ? reason : '',
  };
}
