// @vitest-environment node
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { attachCanvasWsProxy, isCanvasUpgrade, upstreamHeaders } from '../runtime/canvasWsProxy.mjs';

/**
 * Spec 2042 — the harness host advertises `wss://<front>/omadia-ui/canvas`,
 * and the upgrade used to hang in Next. The front relays exactly that path to
 * the middleware, with the session cookie, and passes a refusal through.
 */

const servers: Server[] = [];
/** Upgraded sockets leave the server's books: tracked here so teardown ends them. */
const sockets = new Set<Duplex>();

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on('connection', (socket: Duplex) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A middleware that accepts the canvas upgrade with a session cookie, echoes
 *  bytes, and answers 401 without one. */
function fakeMiddleware(seen: Array<IncomingMessage['headers']>): Server {
  const server = createServer((_req, res) => res.end('http'));
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    seen.push(req.headers);
    if (req.headers.cookie !== 'omadia_session=ok') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk: Buffer) => socket.write(chunk));
  });
  return server;
}

async function front(middlewarePort: number, nextSaw: string[]): Promise<number> {
  const server = attachCanvasWsProxy(
    createServer((_req, res) => res.end('next')),
    () => ({ middlewareUrl: `http://127.0.0.1:${String(middlewarePort)}`, scheme: 'https', log: () => {} }),
  );
  // Next's own listener: it must never see the canvas path
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    nextSaw.push(req.url ?? '');
    socket.destroy();
  });
  return listen(server);
}

function upgrade(
  port: number,
  path: string,
  cookie?: string,
): Promise<{ kind: 'upgrade'; socket: Duplex } | { kind: 'response'; status: number } | { kind: 'error' }> {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'X-Forwarded-Proto': 'http',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    req.on('upgrade', (_res, socket) => resolve({ kind: 'upgrade', socket }));
    req.on('response', (res) => {
      res.resume();
      resolve({ kind: 'response', status: res.statusCode ?? 0 });
    });
    req.on('error', () => resolve({ kind: 'error' }));
    req.end();
  });
}

describe('canvas WebSocket relay on the web-ui front', () => {
  it('relays the canvas upgrade with the session cookie and joins the sockets', async () => {
    const seen: Array<IncomingMessage['headers']> = [];
    const nextSaw: string[] = [];
    const port = await front(await listen(fakeMiddleware(seen)), nextSaw);
    const result = await upgrade(port, '/omadia-ui/canvas?v=1', 'omadia_session=ok');
    expect(result.kind).toBe('upgrade');
    if (result.kind !== 'upgrade') return;
    const echoed = new Promise<string>((resolve) => result.socket.once('data', (b: Buffer) => resolve(b.toString())));
    result.socket.write('ping');
    expect(await echoed).toBe('ping');
    result.socket.destroy();
    expect(nextSaw).toEqual([]);
    // the scheme is this hop's declaration, never the client's header
    expect(seen[0]?.['x-forwarded-proto']).toBe('https');
    expect(seen[0]?.['x-forwarded-host']).toBe(`127.0.0.1:${String(port)}`);
  });

  it('passes a refusal through instead of hanging', async () => {
    const nextSaw: string[] = [];
    const port = await front(await listen(fakeMiddleware([])), nextSaw);
    expect(await upgrade(port, '/omadia-ui/canvas')).toEqual({ kind: 'response', status: 401 });
  });

  it('answers 502 when the middleware is unreachable', async () => {
    const closed = createServer();
    const deadPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    servers.splice(servers.indexOf(closed), 1);
    const port = await front(deadPort, []);
    expect(await upgrade(port, '/omadia-ui/canvas', 'omadia_session=ok')).toEqual({ kind: 'response', status: 502 });
  });

  it('leaves every other upgrade to Next', async () => {
    const nextSaw: string[] = [];
    const seen: Array<IncomingMessage['headers']> = [];
    const port = await front(await listen(fakeMiddleware(seen)), nextSaw);
    await upgrade(port, '/_next/webpack-hmr');
    await upgrade(port, '/omadia-ui/canvas/other');
    expect(nextSaw).toEqual(['/_next/webpack-hmr', '/omadia-ui/canvas/other']);
    expect(seen).toEqual([]);
  });

  it('matches the canvas path exactly', () => {
    expect(isCanvasUpgrade('/omadia-ui/canvas')).toBe(true);
    expect(isCanvasUpgrade('/omadia-ui/canvas?x=1')).toBe(true);
    expect(isCanvasUpgrade('/omadia-ui/canvasx')).toBe(false);
    expect(isCanvasUpgrade(undefined)).toBe(false);
  });

  it('drops this hop’s headers and keeps the upgrade handshake', () => {
    const headers = upstreamHeaders(
      {
        host: 'front',
        upgrade: 'websocket',
        connection: 'Upgrade',
        cookie: 'a=b',
        'x-forwarded-proto': 'http',
        'x-forwarded-host': 'evil.example',
      },
      'https',
    );
    expect(headers).toEqual({
      upgrade: 'websocket',
      connection: 'Upgrade',
      cookie: 'a=b',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'front',
    });
  });
});
