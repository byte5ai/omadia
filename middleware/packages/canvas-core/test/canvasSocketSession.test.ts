import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CanvasSocket,
  CLOSE_SESSION_EXPIRED,
  CLOSE_SESSION_FORBIDDEN,
  type CanvasSocketOptions,
  type WsLike,
} from '../src/canvasSocket.js';
import type { ConnectionStatus } from '../src/connection.js';

/**
 * The client half of the session-lifetime contract. The server closes a
 * canvas socket with 4401 when its session expires (or no longer verifies)
 * and with 4403 when it was revoked or the identity is no longer authorised.
 * Neither is a network drop: reconnecting with the same cookie can only be
 * refused, so the backoff loop must stop and hand the decision to the host.
 */

/** A scriptable stand-in for a platform WebSocket. */
class FakeWs implements WsLike {
  readyState = 0;
  sent: string[] = [];
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string> | undefined,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** The server side of the script. */
  accept(ack: Record<string, unknown> = {}): void {
    this.readyState = 1;
    this.deliver({
      type: 'handshake_offer',
      handshakeId: 'h1',
      protocolVersions: ['1.0'],
      opsCatalogVersions: ['1.0'],
    });
    this.deliver({ type: 'handshake_ack', handshakeId: 'h1', canvasSessionId: 'c1', ...ack });
  }

  deliver(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: true });
  }
}

function harness(cookie?: CanvasSocketOptions['cookie']) {
  const sockets: FakeWs[] = [];
  const statuses: ConnectionStatus[] = [];
  const socket = new CanvasSocket({
    url: 'ws://omadia.test/omadia-ui/canvas',
    ...(cookie !== undefined ? { cookie } : {}),
    localOperations: [],
    session: { load: () => undefined, save: () => undefined },
    createWebSocket: (url, headers) => {
      const ws = new FakeWs(url, headers);
      sockets.push(ws);
      return ws;
    },
    onMessage: () => undefined,
    onStatus: (s) => statuses.push(s),
  });
  const last = (): FakeWs => {
    const ws = sockets[sockets.length - 1];
    if (!ws) throw new Error('no socket opened');
    return ws;
  };
  return { socket, sockets, statuses, last, lastStatus: () => statuses[statuses.length - 1] };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CanvasSocket — session close codes', () => {
  it('uses the protocol close codes', () => {
    expect(CLOSE_SESSION_EXPIRED).toBe(4401);
    expect(CLOSE_SESSION_FORBIDDEN).toBe(4403);
  });

  it("reports the ack's session expiry in the ready status", () => {
    const h = harness('omadia_session=a');
    h.socket.connect();
    h.last().accept({ sessionExpiresAt: 1_900_000_000 });
    expect(h.lastStatus()).toEqual({
      state: 'ready',
      canvasSessionId: 'c1',
      sessionExpiresAt: 1_900_000_000,
    });
  });

  it('4401 stops the backoff and reports unauthenticated; connect() reopens with the current cookie', () => {
    let cookie = 'omadia_session=old';
    const h = harness(() => cookie);
    h.socket.connect();
    expect(h.last().headers).toEqual({ Cookie: 'omadia_session=old' });
    h.last().accept();

    h.last().serverClose(4401, 'session expired');
    expect(h.lastStatus()).toEqual({
      state: 'unauthenticated',
      closeCode: 4401,
      detail: 'session expired',
    });
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(1);

    // The host renewed (or signed in again) and asks for the socket back.
    cookie = 'omadia_session=new';
    h.socket.connect();
    expect(h.sockets).toHaveLength(2);
    expect(h.last().headers).toEqual({ Cookie: 'omadia_session=new' });
  });

  it('4403 is terminal: reports forbidden and never reconnects on its own', () => {
    const h = harness('omadia_session=a');
    h.socket.connect();
    h.last().accept();

    h.last().serverClose(4403, 'session revoked');
    expect(h.lastStatus()).toEqual({
      state: 'forbidden',
      closeCode: 4403,
      detail: 'session revoked',
    });
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('a policy close before the handshake completes is handled the same way', () => {
    const h = harness('omadia_session=a');
    h.socket.connect();
    h.last().serverClose(4401, 'session expired');
    expect(h.lastStatus()?.state).toBe('unauthenticated');
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it.each([
    { code: CLOSE_SESSION_FORBIDDEN, state: 'forbidden', reason: 'session revoked' },
    { code: CLOSE_SESSION_EXPIRED, state: 'unauthenticated', reason: 'session expired' },
  ] as const)(
    'a canvas switch after $code opens nothing; the next connect() resumes that canvas',
    ({ code, state, reason }) => {
      const h = harness('omadia_session=a');
      h.socket.connect();
      h.last().accept();
      h.last().serverClose(code, reason);
      const ended = h.lastStatus();
      expect(ended?.state).toBe(state);

      // The same cookie would be refused before the upgrade, which reads as a
      // network drop (1006) and would restart the backoff loop.
      h.socket.switchCanvas('c2');
      vi.advanceTimersByTime(120_000);
      expect(h.sockets).toHaveLength(1);
      expect(h.lastStatus()).toBe(ended);

      // The host has a valid session again: connect() opens on the new canvas.
      h.socket.connect();
      expect(h.sockets).toHaveLength(2);
      h.last().accept();
      expect(JSON.parse(h.last().sent[0] ?? '{}')).toMatchObject({
        type: 'handshake_select',
        canvasSessionId: 'c2',
      });
    },
  );

  it("a session close that crosses the host's own close() still ends the session", () => {
    const h = harness('omadia_session=a');
    h.socket.connect();
    h.last().accept();

    // The host closes while the server's 4401 is already on the wire; the
    // close event then carries the server's code.
    h.socket.close();
    h.last().serverClose(4401, 'session expired');
    expect(h.lastStatus()?.state).toBe('unauthenticated');

    h.socket.switchCanvas('c2');
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('a canvas switch on a live session still reopens at once on the new canvas', () => {
    const h = harness('omadia_session=a');
    h.socket.connect();
    h.last().accept();

    h.socket.switchCanvas('c2');
    expect(h.sockets).toHaveLength(2);
    expect(h.lastStatus()).toEqual({ state: 'connecting' });
    h.last().accept();
    expect(JSON.parse(h.last().sent[0] ?? '{}')).toMatchObject({ canvasSessionId: 'c2' });
  });

  it('a network drop still reconnects with backoff and the same cookie source', () => {
    const h = harness('omadia_session=a');
    h.socket.connect();
    h.last().accept();

    h.last().serverClose(1006);
    expect(h.lastStatus()).toEqual({ state: 'connecting', detail: 'reconnecting in 1000ms' });
    vi.advanceTimersByTime(1000);
    expect(h.sockets).toHaveLength(2);
    expect(h.last().headers).toEqual({ Cookie: 'omadia_session=a' });
  });

  it('connect() during a pending backoff does not open a second socket', () => {
    const h = harness('omadia_session=a');
    h.socket.connect();
    h.last().accept();
    h.last().serverClose(1006);

    h.socket.connect();
    vi.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(2);
  });
});
