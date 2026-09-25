/**
 * Shared fixtures for the WebSocketRegistry suites: a session-cookie minter,
 * a bearer-only kernel authenticator, a registry mounted on a real loopback
 * http.Server, and client helpers that assert on the raw upgrade outcome.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';

import { SESSION_COOKIE } from '../../src/auth/requireAuth.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import {
  WebSocketRegistry,
  type WebSocketAuthenticator,
  type WebSocketRegistryDeps,
} from '../../src/channels/webSocketRegistry.js';

// Deterministic 64-byte HS512 key for the test (resolveSessionSigningKey
// mints one of this length in prod).
export const KEY = new Uint8Array(64).fill(7);
// Only this email is whitelisted — mirrors the requireAuth Entra gate.
export const WHITELIST = new EmailWhitelist('allowed@example.com');

export async function authCookie(): Promise<string> {
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

export async function entraCookie(email: string): Promise<string> {
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

export interface TestPrincipal {
  satelliteId: string;
}

/** Accepts only `Authorization: Bearer good`; never looks at cookies. */
export const bearerAuth: WebSocketAuthenticator<TestPrincipal> = async (req) =>
  req.headers.authorization === 'Bearer good'
    ? { ok: true, principal: { satelliteId: 'sat-1' } }
    : { ok: false, status: 401 };

export interface RegistryServer {
  registry: WebSocketRegistry;
  server: Server;
  /** `ws://127.0.0.1:<port>` */
  base: string;
  port: number;
  close: () => Promise<void>;
}

/** A registry attached to a real http.Server on an IPv4 loopback port. */
export async function startRegistryServer(
  deps: Partial<WebSocketRegistryDeps> = {},
): Promise<RegistryServer> {
  const registry = new WebSocketRegistry({ signingKey: KEY, whitelist: WHITELIST, ...deps });
  const server = createServer();
  registry.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    registry,
    server,
    port,
    base: `ws://127.0.0.1:${String(port)}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

/** Resolve with the close code the server sent. */
export async function closeCode(ws: WebSocket): Promise<number> {
  const [code] = (await once(ws, 'close')) as [number, Buffer];
  return code;
}

/**
 * Open a client. Late transport errors (EPIPE/ECONNRESET while the server
 * tears down a socket it just closed with 1009) are swallowed — the tests
 * assert on the close code, not on the client's write side.
 */
export async function openClient(
  url: string,
  headers: Record<string, string> = {},
): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers });
  await once(ws, 'open');
  ws.on('error', () => undefined);
  return ws;
}

/**
 * Assert the upgrade is refused with exactly `status` and that the client
 * never saw a 101. `ws` reports a non-101 as `Unexpected server response: N`.
 */
export async function expectRejected(
  url: string,
  status: 401 | 403 | 404 | 503,
  headers: Record<string, string> = {},
): Promise<void> {
  const ws = new WebSocket(url, { headers });
  let upgraded = false;
  ws.on('upgrade', () => {
    upgraded = true;
  });
  const [err] = (await once(ws, 'error')) as [Error];
  assert.match(err.message, new RegExp(`: ${String(status)}$`));
  assert.equal(upgraded, false, 'a rejected peer must never see a 101');
}

export async function echo(ws: WebSocket, payload: string): Promise<string> {
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
export function watchUncaught(): { stop: () => Error[] } {
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

export async function closeClient(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, 'close');
  ws.close();
  await closed;
}

/**
 * Per-test deadline: the suites wait on unbounded `once(ws, …)` events, so a
 * regression must fail fast instead of hanging until `--test-timeout`.
 */
export const FAST = { timeout: 10_000 } as const;
