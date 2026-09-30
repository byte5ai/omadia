/**
 * Shared fixtures for the WebSocketRegistry suites: a session-cookie minter
 * (any lifetime, any local user), a revocation guard and a withdrawable
 * whitelist for the session-lifetime checks, a bearer-only kernel
 * authenticator, a registry mounted on a real loopback http.Server, and client
 * helpers that assert on the raw upgrade outcome and on close codes.
 */

import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { WebSocket } from 'ws';

import { SESSION_COOKIE } from '../../src/auth/requireAuth.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import {
  SessionRevocationGuard,
  type SessionAccount,
} from '../../src/auth/sessionRevocation.js';
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

export interface CookieOpts {
  /** Session version the token claims (`sv`). */
  sv?: number;
  /** `users.id` the token is bound to (`uid`). */
  uid?: string;
  /**
   * Token lifetime, as jose takes it: a duration (`'2s'`) or an ABSOLUTE
   * epoch in seconds. Default: the production 4h window.
   */
  expiresIn?: string | number;
  /** Local identity; default `u1` / `u1@example.com`. */
  sub?: string;
  email?: string;
}

/** A local session for `u1` (or `sub`); `sv`/`uid` pin the revocation claims. */
export async function authCookie(opts: CookieOpts = {}): Promise<string> {
  const token = await signSession(
    {
      sub: opts.sub ?? 'u1',
      email: opts.email ?? 'u1@example.com',
      display_name: 'User One',
      provider: 'local',
      role: 'admin',
      ...(opts.sv !== undefined ? { sv: opts.sv } : {}),
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    },
    KEY,
    opts.expiresIn,
  );
  return `${SESSION_COOKIE}=${token}`;
}

/** The raw token inside a `omadia_session=<token>` cookie from this kit. */
export function tokenOf(cookie: string): string {
  return cookie.slice(`${SESSION_COOKIE}=`.length);
}

/**
 * An `EmailWhitelist` whose verdict a test can withdraw after the upgrade —
 * the production whitelist is env-static, so this stands in for "the
 * identity is no longer authorised" on the periodic re-check.
 */
export class MutableWhitelist extends EmailWhitelist {
  private readonly withdrawn = new Set<string>();

  withdraw(email: string): void {
    this.withdrawn.add(email.toLowerCase());
  }

  override isAllowed(email: string): boolean {
    return !this.withdrawn.has(email.toLowerCase()) && super.isAllowed(email);
  }
}

/**
 * A server-side revocation guard over an in-memory account table keyed
 * `<provider>:<sub>` — the WS suites' stand-in for the users table. Change
 * `accounts` to revoke; make `fail` return true to simulate an outage;
 * `onLookup` sees every account read (i.e. every session check) and may
 * delay it (`await` inside) to hold a check open.
 */
export function revocationGuard(
  accounts: Map<string, SessionAccount>,
  opts: { fail?: () => boolean; onLookup?: () => void | Promise<void> } = {},
): SessionRevocationGuard {
  const guard = new SessionRevocationGuard(() => undefined);
  guard.attach({
    findByProviderUserId: async (provider, sub) => {
      await opts.onLookup?.();
      if (opts.fail?.()) throw new Error('users table unreachable');
      return accounts.get(`${provider}:${sub}`) ?? null;
    },
  });
  return guard;
}

export async function entraCookie(
  email: string,
  opts: Pick<CookieOpts, 'expiresIn'> = {},
): Promise<string> {
  const token = await signSession(
    {
      sub: 'e1',
      email,
      display_name: 'Entra User',
      provider: 'entra',
      role: 'admin',
    },
    KEY,
    opts.expiresIn,
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
  const connections = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
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
      // A test that failed half-way can leave a socket open, and `close`
      // would wait on it forever: the report would read "timed out" instead
      // of naming the failed assertion. Drop whatever is left.
      for (const socket of connections) socket.destroy();
      await once(server, 'close');
    },
  };
}

/** Resolve with the close code the server sent. */
export async function closeCode(ws: WebSocket): Promise<number> {
  const [code] = (await once(ws, 'close')) as [number, Buffer];
  return code;
}

/** Resolve with the close code and reason the server sent, and when it arrived. */
export async function closeInfo(
  ws: WebSocket,
): Promise<{ code: number; reason: string; at: number }> {
  const [code, reason] = (await once(ws, 'close')) as [number, Buffer];
  return { code, reason: reason.toString(), at: Date.now() };
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
