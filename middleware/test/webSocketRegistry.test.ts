/**
 * PR-11 — WebSocketRegistry (Omadia UI canvas transport).
 *
 * Proves the load-bearing contract end-to-end against a real http.Server and a
 * real `ws` client:
 *   - an authenticated upgrade (valid session cookie) completes, the handler
 *     receives the verified ChannelSessionClaims, and text frames round-trip;
 *   - an upgrade with NO session cookie is rejected pre-101 with exactly 401
 *     (auth before the handshake — the handler never runs);
 *   - an unknown path is rejected with 404;
 *   - a de-whitelisted entra session is rejected with 403;
 *   - a deactivated channel rejects new upgrades with 503.
 *
 * Epic #746 W1-1 — per-route authenticator + payload cap:
 *   - a kernel route authenticates with its OWN authenticator (cookies ignored),
 *     and a rejection is a raw 401/403 before any 101;
 *   - `maxPayload` is per route: an oversized frame closes only that socket
 *     with 1009 and the process survives (an `'error'` listener is attached);
 *   - kernel and channel routes cannot share a path;
 *   - kernel sockets do not follow channel deactivation.
 *
 * Deadlines, 503-on-throw, raw status-line bytes and the auth/deactivate race
 * live in `webSocketRegistryHardening.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { CHANNEL_WS_MAX_PAYLOAD_BYTES } from '../src/channels/webSocketRegistry.js';
import {
  FAST,
  authCookie,
  bearerAuth,
  closeClient,
  closeCode,
  echo,
  entraCookie,
  expectRejected,
  openClient,
  startRegistryServer,
  watchUncaught,
  type RegistryServer,
  type TestPrincipal,
} from './_helpers/wsRegistryKit.js';

describe('WebSocketRegistry — auth before upgrade', () => {
  let rs: RegistryServer;

  before(async () => {
    rs = await startRegistryServer();
  });

  after(async () => {
    await rs.close();
  });

  it('accepts an authenticated upgrade, delivers claims, round-trips a frame', FAST, async () => {
    let seenSubject: string | undefined;
    rs.registry.register('ch.test', '/canvas', (socket, session) => {
      seenSubject = session.subject;
      socket.onMessage((m) => socket.send(`echo:${m}`));
    });

    const ws = new WebSocket(`${rs.base}/canvas`, {
      headers: { cookie: await authCookie() },
    });
    await once(ws, 'open');
    ws.send('hi');
    const [reply] = (await once(ws, 'message')) as [Buffer];
    assert.equal(reply.toString(), 'echo:hi');
    assert.equal(seenSubject, 'u1');
    ws.close();
  });

  it('rejects an upgrade with no session cookie with 401 (handler never runs)', FAST, async () => {
    rs.registry.register('ch.noauth', '/canvas-noauth', () => {
      throw new Error('handler must not run for an unauthenticated peer');
    });
    await expectRejected(`${rs.base}/canvas-noauth`, 401);
  });

  it('rejects an unknown path with 404', FAST, async () => {
    await expectRejected(`${rs.base}/no-such-path`, 404, { cookie: await authCookie() });
  });

  it('rejects an entra session whose email is no longer whitelisted with 403 (handler never runs)', FAST, async () => {
    rs.registry.register('ch.entra', '/canvas-entra', () => {
      throw new Error('handler must not run for a de-whitelisted entra peer');
    });
    await expectRejected(`${rs.base}/canvas-entra`, 403, {
      cookie: await entraCookie('revoked@example.com'),
    });
  });

  it('accepts an entra session whose email is whitelisted', FAST, async () => {
    let ran = false;
    rs.registry.register('ch.entra-ok', '/canvas-entra-ok', (socket) => {
      ran = true;
      socket.close();
    });
    const ws = new WebSocket(`${rs.base}/canvas-entra-ok`, {
      headers: { cookie: await entraCookie('allowed@example.com') },
    });
    await once(ws, 'open');
    await once(ws, 'close');
    assert.equal(ran, true);
  });

  it('rejects an upgrade for a deactivated channel with 503', FAST, async () => {
    rs.registry.register('ch.off', '/canvas-off', () => {
      throw new Error('handler must not run for a deactivated channel');
    });
    rs.registry.deactivateChannel('ch.off');
    await expectRejected(`${rs.base}/canvas-off`, 503, { cookie: await authCookie() });
  });
});

describe('WebSocketRegistry — per-route auth + payload cap', () => {
  const CHANNEL_CAP = 64 * 1024;
  let rs: RegistryServer;

  before(async () => {
    rs = await startRegistryServer({ channelMaxPayloadBytes: CHANNEL_CAP });
  });

  after(async () => {
    await rs.close();
  });

  it('a kernel route uses its own authenticator and ignores the session cookie', FAST, async () => {
    let seen: TestPrincipal | undefined;
    rs.registry.registerKernel<TestPrincipal>('/kernel-auth', {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: (ws, _req, principal) => {
        seen = principal;
        // Raw `ws` access: binary frames round-trip as binary.
        ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
      },
    });

    // Valid session cookie, no bearer: the cookie buys nothing on a kernel route.
    await expectRejected(`${rs.base}/kernel-auth`, 401, { cookie: await authCookie() });
    assert.equal(seen, undefined, 'handler must not run for a rejected peer');

    const ws = await openClient(`${rs.base}/kernel-auth`, { authorization: 'Bearer good' });
    assert.deepEqual(seen, { satelliteId: 'sat-1' });
    ws.send(Buffer.from([1, 2, 3]));
    const [reply, isBinary] = (await once(ws, 'message')) as [Buffer, boolean];
    assert.equal(isBinary, true);
    assert.deepEqual([...reply], [1, 2, 3]);
    await closeClient(ws);
  });

  it('a rejecting authenticator answers with a raw 401/403 and no 101 (handler never runs)', FAST, async () => {
    const neverRuns = (): void => {
      throw new Error('handler must not run for a rejected peer');
    };
    rs.registry.registerKernel('/kernel-403', {
      authenticate: async () => ({ ok: false, status: 403 }),
      maxPayload: 1024,
      handler: neverRuns,
    });
    rs.registry.registerKernel('/kernel-401', {
      authenticate: async () => ({ ok: false, status: 401 }),
      maxPayload: 1024,
      handler: neverRuns,
    });

    await expectRejected(`${rs.base}/kernel-403`, 403);
    await expectRejected(`${rs.base}/kernel-401`, 401);
  });

  it('maxPayload is per route: 1009 closes only the offending socket, the process survives', FAST, async () => {
    rs.registry.registerKernel<TestPrincipal>('/kernel-cap', {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: (ws) => ws.on('message', (data) => ws.send(data)),
    });
    rs.registry.register('ch.cap', '/channel-cap', (socket) => {
      socket.onMessage((m) => socket.send(m));
    });

    const kernel = await openClient(`${rs.base}/kernel-cap`, { authorization: 'Bearer good' });
    const channel = await openClient(`${rs.base}/channel-cap`, { cookie: await authCookie() });
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
    const again = await openClient(`${rs.base}/channel-cap`, { cookie: await authCookie() });
    assert.equal(await echo(again, 'ok'), 'ok');
    await closeClient(again);
    assert.deepEqual(
      uncaught.stop().map((e) => e.message),
      [],
      'an oversized frame must not raise an uncaught exception',
    );
  });

  it('kernel and channel routes cannot share a path', () => {
    const route = {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: () => undefined,
    };
    rs.registry.registerKernel('/collide-x', route);
    assert.throws(() => rs.registry.register('ch.x', '/collide-x', () => undefined), /kernel/);
    assert.throws(() => rs.registry.registerKernel('/collide-x', route), /already/);

    rs.registry.register('ch.y', '/collide-y', () => undefined);
    assert.throws(() => rs.registry.registerKernel('/collide-y', route), /ch\.y/);
  });

  it('deactivateChannel does not close kernel sockets or gate kernel upgrades', FAST, async () => {
    rs.registry.registerKernel<TestPrincipal>('/kernel-live', {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: (ws) => ws.on('message', (data) => ws.send(data)),
    });
    rs.registry.register('ch.live', '/channel-live', (socket) => {
      socket.onMessage((m) => socket.send(m));
    });

    const kernel = await openClient(`${rs.base}/kernel-live`, { authorization: 'Bearer good' });
    const channel = await openClient(`${rs.base}/channel-live`, { cookie: await authCookie() });

    const channelClosed = closeCode(channel);
    rs.registry.deactivateChannel('ch.live');
    assert.equal(await channelClosed, 1001);

    assert.equal(await echo(kernel, 'still here'), 'still here');
    const fresh = await openClient(`${rs.base}/kernel-live`, { authorization: 'Bearer good' });
    assert.equal(await echo(fresh, 'new'), 'new');
    await expectRejected(`${rs.base}/channel-live`, 503, { cookie: await authCookie() });

    await closeClient(kernel);
    await closeClient(fresh);
  });

  it('an unregistered path is still 404 when kernel routes exist', FAST, async () => {
    rs.registry.registerKernel('/kernel-404-neighbour', {
      authenticate: bearerAuth,
      maxPayload: 1024,
      handler: () => undefined,
    });
    await expectRejected(`${rs.base}/nothing-here`, 404, { authorization: 'Bearer good' });
  });
});

describe('WebSocketRegistry — default channel payload cap', () => {
  it('is 32 MiB, and a frame one byte over it closes the channel socket with 1009', { timeout: 60_000 }, async () => {
    assert.equal(CHANNEL_WS_MAX_PAYLOAD_BYTES, 32 * 1024 * 1024);

    const rs = await startRegistryServer();
    try {
      rs.registry.register('ch.default', '/default-cap', () => undefined);
      const ws = await openClient(`${rs.base}/default-cap`, { cookie: await authCookie() });
      const uncaught = watchUncaught();
      const closed = closeCode(ws);
      ws.send(Buffer.alloc(CHANNEL_WS_MAX_PAYLOAD_BYTES + 1));
      assert.equal(await closed, 1009);
      assert.deepEqual(uncaught.stop().map((e) => e.message), []);
    } finally {
      await rs.close();
    }
  });
});
