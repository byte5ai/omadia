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
import { WebSocketRegistry } from '../src/channels/webSocketRegistry.js';

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
