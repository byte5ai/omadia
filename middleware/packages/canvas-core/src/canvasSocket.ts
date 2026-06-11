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

export interface CanvasSocketOptions {
  url: string;
  /** `omadia_session=…` header value; omit for the stub server */
  cookie?: string;
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

  connect(): void {
    this.closedByUser = false;
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
    const headers = this.opts.cookie ? { Cookie: this.opts.cookie } : undefined;
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
          this.opts.onStatus({ state: 'ready', canvasSessionId: action.canvasSessionId });
        } else {
          this.opts.onStatus({ state: 'failed', detail: action.reason });
          this.closedByUser = true; // version failure is terminal, not retryable
          ws.close(1002, action.reason);
        }
        return;
      }
      this.opts.onMessage(msg);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ready = false;
      if (this.switching) {
        return;
      }
      if (this.closedByUser) {
        this.opts.onStatus({ state: 'disconnected' });
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
