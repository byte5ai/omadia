import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, before, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';
import { WebSocket } from 'ws';

import type { AdminAuditLog } from '../../src/auth/adminAuditLog.js';
import { hashPassword } from '../../src/auth/passwordHasher.js';
import { LocalPasswordProvider } from '../../src/auth/providers/LocalPasswordProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import { publicPaths } from '../../src/auth/publicPaths.js';
import { createRequireAuth, SESSION_COOKIE } from '../../src/auth/requireAuth.js';
import { SessionRevocationGuard } from '../../src/auth/sessionRevocation.js';
import type { UpdateUserInput, UserRecord, UserStore } from '../../src/auth/userStore.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { WebSocketRegistry } from '../../src/channels/webSocketRegistry.js';
import { createAdminUsersRouter } from '../../src/routes/adminUsers.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * Live channel WebSockets follow the session that opened them, end to end:
 * the real auth router (password login, `/renew`, `/logout`) and admin-users
 * router behind the real `requireAuth`, with a `WebSocketRegistry` on the SAME
 * http.Server, all sharing one revocation guard over an in-memory `users`
 * table — the production wiring in `index.ts`.
 *
 *   - renewing the cookie does not close a socket opened with the pre-renew
 *     token: renewal never moves the session version, so the re-check keeps
 *     finding that token current;
 *   - signing out closes the user's open socket at once (4403), through the
 *     route's revocation announcement;
 *   - an admin disabling a user closes that user's socket at once, and leaves
 *     the admin's own socket alone.
 */

const KEY = new TextEncoder().encode('W'.repeat(64));
const EMAIL = 'operator@example.com';
const SECOND = 'second@example.com';
const PASSWORD = 'correct horse battery';
const RECHECK_MS = 25;

type Row = UserRecord & { passwordHash?: string };

function publicRow(row: Row): UserRecord {
  const { passwordHash: _hash, ...rest } = row;
  return rest;
}

/** The subset of `UserStore` the routers, the provider and the guard touch. */
class UsersTable {
  rows: Row[] = [];

  async count(): Promise<number> {
    return this.rows.length;
  }

  async findByEmailWithHash(provider: string, email: string): Promise<UserRecord | null> {
    const row = this.rows.find(
      (r) => r.provider === provider && r.email.toLowerCase() === email.toLowerCase(),
    );
    return row ? { ...row } : null;
  }

  async findByProviderUserId(provider: string, sub: string): Promise<UserRecord | null> {
    const row = this.rows.find((r) => r.provider === provider && r.providerUserId === sub);
    return row ? publicRow(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? publicRow(row) : null;
  }

  async update(id: string, patch: UpdateUserInput): Promise<UserRecord | null> {
    const idx = this.rows.findIndex((r) => r.id === id);
    const cur = this.rows[idx];
    if (!cur) return null;
    const next: Row = {
      ...cur,
      status: patch.status ?? cur.status,
      sessionVersion: cur.sessionVersion + (patch.revokeSessions ? 1 : 0),
    };
    this.rows[idx] = next;
    return publicRow(next);
  }

  async markLoginNow(): Promise<void> {
    /* fire-and-forget in the router */
  }
}

function seedRow(id: string, email: string, passwordHash: string): Row {
  const now = new Date();
  return {
    id,
    email,
    provider: 'local',
    providerUserId: email,
    displayName: email,
    role: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    sessionVersion: 0,
    passwordHash,
  };
}

interface Harness {
  base: string;
  ws: string;
}

let passwordHash: string;
let servers: Server[] = [];

before(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

afterEach(async () => {
  const open = servers;
  servers = [];
  await Promise.all(open.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function start(): Promise<Harness> {
  const table = new UsersTable();
  table.rows.push(seedRow('row-local-1', EMAIL, passwordHash));
  table.rows.push(seedRow('row-local-2', SECOND, passwordHash));
  const userStore = table as unknown as UserStore;

  const sessions = new SessionRevocationGuard(() => undefined);
  sessions.attach(userStore);
  const registry = new ProviderRegistry();
  registry.replaceActive([new LocalPasswordProvider(userStore)]);
  const whitelist = new EmailWhitelist(undefined);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api',
    createRequireAuth({ signingKey: KEY, whitelist, sessions, publicPaths: publicPaths() }),
  );
  app.use(
    '/api/v1/auth',
    createAuthRouter({
      registry,
      userStore,
      signingKey: KEY,
      publicBaseUrl: 'http://localhost',
      defaultReturnPath: '/',
      setupAllowed: false,
      sessions,
      renewal: {
        whitelist,
        audit: { record: async () => undefined },
        refreshStore: { forget: async () => undefined },
        maxLifetimeSeconds: 12 * 3600,
      },
    }),
  );
  app.use(
    '/api/v1/admin/users',
    createAdminUsersRouter({
      userStore,
      audit: { record: async () => undefined } as unknown as AdminAuditLog,
      sessions,
    }),
  );

  const server = await listenLoopback(app);
  servers.push(server);
  const sockets = new WebSocketRegistry({
    signingKey: KEY,
    whitelist,
    sessions,
    channelSessionRecheckMs: RECHECK_MS,
  });
  sockets.attach(server);
  sockets.register('ch.canvas', '/canvas', (socket) => {
    socket.onMessage((m) => socket.send(m));
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${String(port)}`, ws: `ws://127.0.0.1:${String(port)}/canvas` };
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = /^omadia_session=([^;]+)/.exec(line);
    if (match?.[1]) return match[1];
  }
  throw new Error('response set no session cookie');
}

async function login(h: Harness, email = EMAIL): Promise<string> {
  const res = await fetch(`${h.base}/api/v1/auth/login/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return sessionCookie(res);
}

async function post(h: Harness, path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${h.base}${path}`, {
    method: path.startsWith('/api/v1/admin/') ? 'PATCH' : 'POST',
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function openSocket(h: Harness, token: string): Promise<WebSocket> {
  const ws = new WebSocket(h.ws, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  await once(ws, 'open');
  ws.on('error', () => undefined);
  return ws;
}

async function echo(ws: WebSocket, payload: string): Promise<string> {
  ws.send(payload);
  const [reply] = (await once(ws, 'message')) as [Buffer];
  return reply.toString();
}

async function closedWithin(ws: WebSocket, ms: number): Promise<[number, string]> {
  const closed = once(ws, 'close').then(([code, reason]) => [
    code as number,
    (reason as Buffer).toString(),
  ]);
  const late = sleep(ms).then(() => {
    throw new Error(`socket still open ${String(ms)} ms later`);
  });
  return (await Promise.race([closed, late])) as [number, string];
}

describe('live channel sockets follow the session that opened them', () => {
  it('a renewal keeps the socket opened with the pre-renew token; sign-out closes it (4403)', async () => {
    const h = await start();
    const original = await login(h);
    const ws = await openSocket(h, original);

    const renewed = await post(h, '/api/v1/auth/renew', original);
    assert.equal(renewed.status, 200);
    const fresh = sessionCookie(renewed);
    await sleep(RECHECK_MS * 8);
    assert.equal(await echo(ws, 'after renew'), 'after renew', 'renewal must not end the socket');

    const closed = closedWithin(ws, 2000);
    assert.equal((await post(h, '/api/v1/auth/logout', fresh)).status, 200);
    assert.deepEqual(await closed, [4403, 'session revoked']);
  });

  it("an admin disabling a user closes that user's socket at once, not the admin's", async () => {
    const h = await start();
    const operator = await login(h);
    const target = await login(h, SECOND);
    const operatorWs = await openSocket(h, operator);
    const targetWs = await openSocket(h, target);

    const closed = closedWithin(targetWs, 2000);
    const res = await post(h, '/api/v1/admin/users/row-local-2', operator, { status: 'disabled' });
    assert.equal(res.status, 200);
    assert.deepEqual(await closed, [4403, 'session revoked']);
    assert.equal(await echo(operatorWs, 'still mine'), 'still mine');
    operatorWs.close();
    await once(operatorWs, 'close');
  });
});
