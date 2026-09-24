/**
 * PR-11 — WebSocketRegistry (Omadia UI canvas transport).
 *
 * Proves the load-bearing contract end-to-end against a real http.Server and a
 * real `ws` client:
 *   - an authenticated upgrade (valid session cookie) completes, the handler
 *     receives the verified ChannelSessionClaims, and text frames round-trip;
 *   - an upgrade with NO session cookie is rejected pre-101 (auth before the
 *     handshake — the handler never runs);
 *   - an unknown path is rejected;
 *   - a deactivated channel rejects new upgrades.
 *
 * Epic #746 W1-1 — per-route authenticator + payload cap:
 *   - a kernel route authenticates with its OWN authenticator (cookies ignored),
 *     and a rejection is a raw 401/403 before any 101;
 *   - `maxPayload` is per route: an oversized frame closes only that socket
 *     with 1009 and the process survives (an `'error'` listener is attached);
 *   - kernel and channel routes cannot share a path;
 *   - kernel sockets do not follow channel deactivation.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { SESSION_COOKIE } from '../src/auth/requireAuth.js';
import { signSession } from '../src/auth/sessionJwt.js';
import { EmailWhitelist } from '../src/auth/whitelist.js';
import {
  CHANNEL_WS_MAX_PAYLOAD_BYTES,
  WebSocketRegistry,
  type WebSocketAuthenticator,
} from '../src/channels/webSocketRegistry.js';

// Deterministic 64-byte HS512 key for the test (resolveSessionSigningKey
// mints one of this length in prod).
const KEY = new Uint8Array(64).fill(7);
// Only this email is whitelisted — mirrors the requireAuth Entra gate.
const WHITELIST = new EmailWhitelist('allowed@example.com');

async function authCookie(): Promise<string> {
  const token = await signSession(
    {
      sub: 'u1',
      email: 'u1@example.com',
      display_name: 'User One',
      provider: 'local',
      role: 'admin',
    },
    KEY,
  );
  return `${SESSION_COOKIE}=${token}`;
}

async function entraCookie(email: string): Promise<string> {
  const token = await signSession(
    {
      sub: 'e1',
      email,
      display_name: 'Entra User',
      provider: 'entra',
      role: 'admin',
    },
    KEY,
  );
  return `${SESSION_COOKIE}=${token}`;
}

describe('WebSocketRegistry — auth before upgrade', () => {
  let server: Server;
  let registry: WebSocketRegistry;
  let port: number;

  before(async () => {
    registry = new WebSocketRegistry({ signingKey: KEY, whitelist: WHITELIST });
    server = createServer();
    registry.attach(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    server.close();
    await once(server, 'close');
  });

  it('accepts an authenticated upgrade, delivers claims, round-trips a frame', async () => {
    let seenSubject: string | undefined;
    registry.register('ch.test', '/canvas', (socket, session) => {
      seenSubject = session.subject;
      socket.onMessage((m) => socket.send(`echo:${m}`));
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/canvas`, {
      headers: { cookie: await authCookie() },
    });
    await once(ws, 'open');
    ws.send('hi');
    const [reply] = (await once(ws, 'message')) as [Buffer];
    assert.equal(reply.toString(), 'echo:hi');
    assert.equal(seenSubject, 'u1');
    ws.close();
  });

  it('rejects an upgrade with no session cookie (handler never runs)', async () => {
    registry.register('ch.noauth', '/canvas-noauth', () => {
      throw new Error('handler must not run for an unauthenticated peer');
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/canvas-noauth`);
    const [err] = (await once(ws, 'error')) as [Error];
    assert.match(err.message, /401|unexpected server response/i);
  });

  it('rejects an unknown path', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/no-such-path`, {
      headers: { cookie: await authCookie() },
    });
    const [err] = (await once(ws, 'error')) as [Error];
    assert.match(err.message, /404|unexpected server response/i);
  });

  it('rejects an entra session whose email is no longer whitelisted (handler never runs)', async () => {
    registry.register('ch.entra', '/canvas-entra', () => {
      throw new Error('handler must not run for a de-whitelisted entra peer');
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/canvas-entra`, {
      headers: { cookie: await entraCookie('revoked@example.com') },
    });
    const [err] = (await once(ws, 'error')) as [Error];
    assert.match(err.message, /403|unexpected server response/i);
  });

  it('accepts an entra session whose email is whitelisted', async () => {
    let ran = false;
    registry.register('ch.entra-ok', '/canvas-entra-ok', (socket) => {
      ran = true;
      socket.close();
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/canvas-entra-ok`, {
      headers: { cookie: await entraCookie('allowed@example.com') },
    });
    await once(ws, 'open');
    await once(ws, 'close');
    assert.equal(ran, true);
  });

  it('rejects an upgrade for a deactivated channel', async () => {
    registry.register('ch.off', '/canvas-off', () => {
      throw new Error('handler must not run for a deactivated channel');
    });
    registry.deactivateChannel('ch.off');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/canvas-off`, {
      headers: { cookie: await authCookie() },
    });
    const [err] = (await once(ws, 'error')) as [Error];
    assert.match(err.message, /503|unexpected server response/i);
  });
});

interface TestPrincipal {
  satelliteId: string;
}

/** Accepts only `Authorization: Bearer good`; never looks at cookies. */
const bearerAuth: WebSocketAuthenticator<TestPrincipal> = async (req) =>
  req.headers.authorization === 'Bearer good'
    ? { ok: true, principal: { satelliteId: 'sat-1' } }
    : { ok: false, status: 401 };

/** Resolve with the close code the server sent. */
async function closeCode(ws: WebSocket): Promise<number> {
  const [code] = (await once(ws, 'close')) as [number, Buffer];
  return code;
}

/**
 * Open a client. Late transport errors (EPIPE/ECONNRESET while the server
 * tears down a socket it just closed with 1009) are swallowed — the tests
 * assert on the close code, not on the client's write side.
 */
async function openClient(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers });
  await once(ws, 'open');
  ws.on('error', () => undefined);
  return ws;
}

async function expectRejected(
  url: string,
  status: RegExp,
  headers: Record<string, string> = {},
): Promise<void> {
  const ws = new WebSocket(url, { headers });
  let upgraded = false;
  ws.on('upgrade', () => {
    upgraded = true;
  });
  const [err] = (await once(ws, 'error')) as [Error];
  assert.match(err.message, status);
  assert.equal(upgraded, false, 'a rejected peer must never see a 101');
}

async function echo(ws: WebSocket, payload: string): Promise<string> {
  ws.send(payload);
  const [reply] = (await once(ws, 'message')) as [Buffer];
  return reply.toString();
}

/**
 * Record uncaught exceptions while a test runs. node:test attributes an
 * uncaught error raised in a server callback to the hook that created the
 * server (often an already-finished `before`), so the test that provoked it
 * would stay green. `uncaughtExceptionMonitor` observes without handling.
 */
function watchUncaught(): { stop: () => Error[] } {
  const seen: Error[] = [];
  const onUncaught = (err: Error): void => {
    seen.push(err);
  };
  process.on('uncaughtExceptionMonitor', onUncaught);
  return {
    stop: () => {
      process.removeListener('uncaughtExceptionMonitor', onUncaught);
      return seen;
    },
  };
}

async function closeClient(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, 'close');
  ws.close();
  await closed;
}

describe('WebSocketRegistry — per-route auth + payload cap', () => {
  const CHANNEL_CAP = 64 * 1024;
  let server: Server;
  let registry: WebSocketRegistry;
  let base: string;

  before(async () => {
    registry = new WebSocketRegistry({
      signingKey: KEY,
      whitelist: WHITELIST,
      channelMaxPayloadBytes: CHANNEL_CAP,
    });
    server = createServer();
    registry.attach(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await once(server, 'close');
  });

  it('a kernel route uses its own authenticator and ignores the session cookie', async () => {
    let seen: TestPrincipal | undefined;
    registry.registerKernel<TestPrincipal>('/kernel-auth', {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: (ws, _req, principal) => {
        seen = principal;
        // Raw `ws` access: binary frames round-trip as binary.
        ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
      },
    });

    // Valid session cookie, no bearer: the cookie buys nothing on a kernel route.
    await expectRejected(`${base}/kernel-auth`, /401/, { cookie: await authCookie() });
    assert.equal(seen, undefined, 'handler must not run for a rejected peer');

    const ws = await openClient(`${base}/kernel-auth`, { authorization: 'Bearer good' });
    assert.deepEqual(seen, { satelliteId: 'sat-1' });
    ws.send(Buffer.from([1, 2, 3]));
    const [reply, isBinary] = (await once(ws, 'message')) as [Buffer, boolean];
    assert.equal(isBinary, true);
    assert.deepEqual([...reply], [1, 2, 3]);
    await closeClient(ws);
  });

  it('a rejecting authenticator answers with a raw 401/403 and no 101 (handler never runs)', async () => {
    const neverRuns = (): void => {
      throw new Error('handler must not run for a rejected peer');
    };
    registry.registerKernel('/kernel-403', {
      // A reason carrying CR/LF must never reach the raw status line.
      authenticate: async () => ({ ok: false, status: 403, message: 'no\r\nX-Injected: 1' }),
      maxPayload: 1024,
      handler: neverRuns,
    });
    registry.registerKernel('/kernel-401', {
      authenticate: async () => ({ ok: false, status: 401 }),
      maxPayload: 1024,
      handler: neverRuns,
    });
    registry.registerKernel('/kernel-throws', {
      authenticate: async () => {
        throw new Error('key store down');
      },
      maxPayload: 1024,
      handler: neverRuns,
    });

    await expectRejected(`${base}/kernel-403`, /403/);
    await expectRejected(`${base}/kernel-401`, /401/);
    // A throwing authenticator fails CLOSED.
    await expectRejected(`${base}/kernel-throws`, /401/);
  });

  it('maxPayload is per route: 1009 closes only the offending socket, the process survives', async () => {
    registry.registerKernel<TestPrincipal>('/kernel-cap', {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: (ws) => ws.on('message', (data) => ws.send(data)),
    });
    registry.register('ch.cap', '/channel-cap', (socket) => {
      socket.onMessage((m) => socket.send(m));
    });

    const kernel = await openClient(`${base}/kernel-cap`, { authorization: 'Bearer good' });
    const channel = await openClient(`${base}/channel-cap`, { cookie: await authCookie() });
    const uncaught = watchUncaught();

    // Under the kernel cap: fine.
    assert.equal(await echo(kernel, 'k'.repeat(512)), 'k'.repeat(512));

    // 2 KiB is over the kernel's 1 KiB cap → 1009 on the kernel socket only.
    const kernelClosed = closeCode(kernel);
    kernel.send('x'.repeat(2048));
    assert.equal(await kernelClosed, 1009);

    // The channel route has its own (64 KiB) cap: 2 KiB still round-trips.
    assert.equal(await echo(channel, 'y'.repeat(2048)), 'y'.repeat(2048));

    // …and one byte over the channel cap closes the channel socket with 1009.
    const channelClosed = closeCode(channel);
    channel.send('z'.repeat(CHANNEL_CAP + 1));
    assert.equal(await channelClosed, 1009);

    // Still serving: a fresh upgrade on the same route works.
    const again = await openClient(`${base}/channel-cap`, { cookie: await authCookie() });
    assert.equal(await echo(again, 'ok'), 'ok');
    await closeClient(again);
    assert.deepEqual(
      uncaught.stop().map((e) => e.message),
      [],
      'an oversized frame must not raise an uncaught exception',
    );
  });

  it('kernel and channel routes cannot share a path; maxPayload must be a positive integer', () => {
    const route = {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: () => undefined,
    };
    registry.registerKernel('/collide-x', route);
    assert.throws(() => registry.register('ch.x', '/collide-x', () => undefined), /kernel/);
    assert.throws(() => registry.registerKernel('/collide-x', route), /already/);

    registry.register('ch.y', '/collide-y', () => undefined);
    assert.throws(() => registry.registerKernel('/collide-y', route), /ch\.y/);

    for (const maxPayload of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => registry.registerKernel(`/bad-cap-${String(maxPayload)}`, { ...route, maxPayload }),
        /maxPayload/,
      );
    }
    assert.throws(
      () =>
        new WebSocketRegistry({
          signingKey: KEY,
          whitelist: WHITELIST,
          channelMaxPayloadBytes: 0,
        }),
      /channelMaxPayloadBytes/,
    );
  });

  it('deactivateChannel does not close kernel sockets or gate kernel upgrades', async () => {
    registry.registerKernel<TestPrincipal>('/kernel-live', {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: (ws) => ws.on('message', (data) => ws.send(data)),
    });
    registry.register('ch.live', '/channel-live', (socket) => {
      socket.onMessage((m) => socket.send(m));
    });

    const kernel = await openClient(`${base}/kernel-live`, { authorization: 'Bearer good' });
    const channel = await openClient(`${base}/channel-live`, { cookie: await authCookie() });

    const channelClosed = closeCode(channel);
    registry.deactivateChannel('ch.live');
    assert.equal(await channelClosed, 1001);

    assert.equal(await echo(kernel, 'still here'), 'still here');
    const fresh = await openClient(`${base}/kernel-live`, { authorization: 'Bearer good' });
    assert.equal(await echo(fresh, 'new'), 'new');
    await expectRejected(`${base}/channel-live`, /503/, { cookie: await authCookie() });

    await closeClient(kernel);
    await closeClient(fresh);
  });

  it('an unregistered path is still 404 when kernel routes exist', async () => {
    registry.registerKernel('/kernel-404-neighbour', {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: () => undefined,
    });
    await expectRejected(`${base}/nothing-here`, /404/, { authorization: 'Bearer good' });
  });
});

describe('WebSocketRegistry — default channel payload cap', () => {
  it('is 32 MiB, and a frame one byte over it closes the channel socket with 1009', async () => {
    assert.equal(CHANNEL_WS_MAX_PAYLOAD_BYTES, 32 * 1024 * 1024);

    const registry = new WebSocketRegistry({ signingKey: KEY, whitelist: WHITELIST });
    const server = createServer();
    registry.attach(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    try {
      registry.register('ch.default', '/default-cap', () => undefined);
      const ws = await openClient(`ws://127.0.0.1:${port}/default-cap`, {
        cookie: await authCookie(),
      });
      const uncaught = watchUncaught();
      const closed = closeCode(ws);
      ws.send(Buffer.alloc(CHANNEL_WS_MAX_PAYLOAD_BYTES + 1));
      assert.equal(await closed, 1009);
      assert.deepEqual(uncaught.stop().map((e) => e.message), []);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
