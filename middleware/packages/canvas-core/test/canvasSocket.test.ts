import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startStubServer } from '../tools/stubServer.js';
import { CanvasSocket, type WsLike } from '../src/canvasSocket.js';
import type { ServerMessage } from '../src/protocol.js';
import type { ConnectionStatus } from '../src/connection.js';

/** Node host adapter: the `ws` client implements the standard handler-property
 *  API (onmessage/onclose/onerror), so it satisfies WsLike directly. */
const nodeWsFactory = (url: string, headers?: Record<string, string>): WsLike =>
  new WebSocket(url, { headers }) as unknown as WsLike;

let server: Awaited<ReturnType<typeof startStubServer>>;
beforeAll(async () => {
  server = await startStubServer(0);
});
afterAll(async () => {
  await server.close();
});

describe('CanvasSocket', () => {
  it('connects, handshakes, persists the session id, and streams a turn', async () => {
    const messages: ServerMessage[] = [];
    const statuses: ConnectionStatus[] = [];
    let persisted: string | undefined;

    const socket = new CanvasSocket({
      url: `ws://127.0.0.1:${server.port}/omadia-ui/canvas`,
      localOperations: [],
      createWebSocket: nodeWsFactory,
      session: {
        load: () => persisted,
        save: (id) => {
          persisted = id;
        },
      },
      onMessage: (m) => messages.push(m),
      onStatus: (s) => statuses.push(s),
    });
    socket.connect();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('never ready')), 5000);
      const poll = setInterval(() => {
        if (statuses.some((s) => s.state === 'ready')) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    expect(persisted).toBe('stub-canvas');

    socket.sendTurn({ type: 'turn', turnId: 't1', text: 'hello' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no turn_complete')), 15_000);
      const poll = setInterval(() => {
        if (messages.some((m) => m.type === 'turn_complete')) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
    expect(messages.some((m) => m.type === 'surface_snapshot')).toBe(true);
    socket.close();
  }, 25_000);
});
