/**
 * Epic #746 W1-1 — WebSocketRegistry hardening (review follow-ups).
 *
 *   - an authenticator that throws, misses its deadline or returns a
 *     non-result fails CLOSED with 503 (an outage must not read as a bad
 *     credential), and the handler never runs — not even if the authenticator
 *     resolves after its deadline;
 *   - a CR/LF-laden rejection reason never reaches the wire: the response is
 *     exactly the fixed status line;
 *   - `maxPayload` / `authTimeoutMs` / `channelMaxPayloadBytes` are bounded
 *     (ws coerces `maxPayload | 0`, so 2^31+ would silently mean "unlimited");
 *   - a malformed session-cookie escape is an ordinary 401;
 *   - a channel deactivated while its cookie is being verified gets 503, not
 *     a socket that escaped `deactivateChannel`.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { SESSION_COOKIE } from '../src/auth/requireAuth.js';
import {
  KERNEL_WS_AUTH_TIMEOUT_MS,
  WS_MAX_PAYLOAD_LIMIT_BYTES,
  WebSocketRegistry,
  type WebSocketAuthResult,
} from '../src/channels/webSocketRegistry.js';
import {
  FAST,
  KEY,
  WHITELIST,
  authCookie,
  bearerAuth,
  expectRejected,
  startRegistryServer,
  type RegistryServer,
} from './_helpers/wsRegistryKit.js';

const neverRuns = (): void => {
  throw new Error('handler must not run for a rejected peer');
};

/** Send a raw upgrade request and return every byte the server answered with. */
async function rawUpgrade(port: number, path: string): Promise<string> {
  const sock = connect(port, '127.0.0.1');
  sock.on('error', () => undefined);
  const chunks: Buffer[] = [];
  sock.on('data', (c: Buffer) => chunks.push(c));
  await once(sock, 'connect');
  sock.write(
    [
      `GET ${path} HTTP/1.1`,
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );
  await once(sock, 'close');
  return Buffer.concat(chunks).toString('latin1');
}

describe('WebSocketRegistry — authenticator failures fail closed', () => {
  let rs: RegistryServer;

  before(async () => {
    rs = await startRegistryServer();
  });

  after(async () => {
    await rs.close();
  });

  it('a throwing authenticator answers 503 with no 101', FAST, async () => {
    rs.registry.registerKernel('/kernel-throws', {
      authenticate: async () => {
        throw new Error('key store down');
      },
      maxPayload: 1024,
      handler: neverRuns,
    });
    await expectRejected(`${rs.base}/kernel-throws`, 503);
  });

  it('an authenticator that misses its deadline answers 503, and a late ok is ignored', FAST, async () => {
    assert.equal(KERNEL_WS_AUTH_TIMEOUT_MS, 10_000);
    let handlerRan = false;
    rs.registry.registerKernel('/kernel-slow', {
      authenticate: async (): Promise<WebSocketAuthResult<string>> => {
        await sleep(300);
        return { ok: true, principal: 'too-late' };
      },
      authTimeoutMs: 50,
      maxPayload: 1024,
      handler: () => {
        handlerRan = true;
      },
    });
    const started = Date.now();
    await expectRejected(`${rs.base}/kernel-slow`, 503);
    assert.ok(Date.now() - started < 300, 'the deadline, not the authenticator, ended the wait');
    await sleep(400);
    assert.equal(handlerRan, false, 'a late ok must not resurrect the upgrade');
  });

  it('an authenticator returning a non-result answers 503', FAST, async () => {
    rs.registry.registerKernel('/kernel-junk', {
      // An untyped JS caller: no result object at all.
      authenticate: async () => undefined as unknown as WebSocketAuthResult<string>,
      maxPayload: 1024,
      handler: neverRuns,
    });
    await expectRejected(`${rs.base}/kernel-junk`, 503);
  });

  it('a CR/LF rejection reason never reaches the wire', FAST, async () => {
    rs.registry.registerKernel('/kernel-crlf', {
      authenticate: async () => ({ ok: false, status: 403, message: 'no\r\nX-Injected: 1' }),
      maxPayload: 1024,
      handler: neverRuns,
    });
    assert.equal(
      await rawUpgrade(rs.port, '/kernel-crlf'),
      'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n',
    );
  });

  it('a malformed session-cookie escape is an ordinary 401', FAST, async () => {
    rs.registry.register('ch.badcookie', '/canvas-badcookie', neverRuns);
    await expectRejected(`${rs.base}/canvas-badcookie`, 401, {
      cookie: `${SESSION_COOKIE}=%E0%A4%A`,
    });
  });

  it('a channel deactivated during cookie verification answers 503', FAST, async () => {
    rs.registry.register('ch.race', '/canvas-race', neverRuns);
    // Runs right after the registry's own listener has parked on the async
    // cookie verification — i.e. inside the auth window.
    const deactivateMidAuth = (): void => rs.registry.deactivateChannel('ch.race');
    rs.server.on('upgrade', deactivateMidAuth);
    try {
      await expectRejected(`${rs.base}/canvas-race`, 503, { cookie: await authCookie() });
    } finally {
      rs.server.removeListener('upgrade', deactivateMidAuth);
    }
  });
});

describe('WebSocketRegistry — route option bounds', () => {
  const route = { authenticate: bearerAuth, maxPayload: 1024, handler: () => undefined };

  it('maxPayload must be a positive integer that ws can represent', () => {
    const registry = new WebSocketRegistry({ signingKey: KEY, whitelist: WHITELIST });
    const bad = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, 2 ** 32];
    for (const maxPayload of bad) {
      assert.throws(
        () => registry.registerKernel(`/bad-cap-${String(maxPayload)}`, { ...route, maxPayload }),
        /maxPayload/,
      );
    }
    assert.equal(WS_MAX_PAYLOAD_LIMIT_BYTES, 2 ** 31 - 1);
    registry.registerKernel('/max-cap', { ...route, maxPayload: WS_MAX_PAYLOAD_LIMIT_BYTES });
  });

  it('authTimeoutMs must be a positive integer setTimeout honours', () => {
    const registry = new WebSocketRegistry({ signingKey: KEY, whitelist: WHITELIST });
    for (const authTimeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      assert.throws(
        () =>
          registry.registerKernel(`/bad-timeout-${String(authTimeoutMs)}`, {
            ...route,
            authTimeoutMs,
          }),
        /authTimeoutMs/,
      );
    }
  });

  it('channelMaxPayloadBytes is bounded the same way', () => {
    for (const channelMaxPayloadBytes of [0, 2 ** 31]) {
      assert.throws(
        () => new WebSocketRegistry({ signingKey: KEY, whitelist: WHITELIST, channelMaxPayloadBytes }),
        /channelMaxPayloadBytes/,
      );
    }
  });
});
