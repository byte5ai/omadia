import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, before, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';

import type { AdminAuditLog } from '../../src/auth/adminAuditLog.js';
import { hashPassword } from '../../src/auth/passwordHasher.js';
import type { OidcProvider } from '../../src/auth/providers/AuthProvider.js';
import { LocalPasswordProvider } from '../../src/auth/providers/LocalPasswordProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import { publicPaths } from '../../src/auth/publicPaths.js';
import { createRequireAuth, SESSION_COOKIE } from '../../src/auth/requireAuth.js';
import { signSession, verifySession } from '../../src/auth/sessionJwt.js';
import { SessionRevocationGuard } from '../../src/auth/sessionRevocation.js';
import type {
  UpdateUserInput,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { createAdminUsersRouter } from '../../src/routes/adminUsers.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * Sign-out ends the session on the server, not just in the browser — and so
 * do an admin password reset, disabling and deleting a user.
 *
 * Drives the production shape end to end: the real auth router with the real
 * `LocalPasswordProvider` and the real admin-users router, behind the real
 * `requireAuth` mounted at `/api` with the production public-path list, all
 * sharing one revocation guard over an in-memory `users` table. The copied
 * cookie is the attacker's: taken before the revocation, replayed after.
 */

const KEY = new TextEncoder().encode('L'.repeat(64));
const EMAIL = 'operator@example.com';
const SECOND = 'second@example.com';
const PASSWORD = 'correct horse battery';
const ENTRA_SUB = 'aad-oid-7';
const ENTRA_EMAIL = 'entra-op@example.com';

type Row = UserRecord & { passwordHash?: string };

function publicRow(row: Row): UserRecord {
  const { passwordHash: _hash, ...rest } = row;
  return rest;
}

/** The subset of `UserStore` the router, the provider and the guard touch. */
class UsersTable {
  rows: Row[] = [];
  patches: Array<{ id: string; patch: UpdateUserInput }> = [];
  failLookups = false;
  failUpdates = false;

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
    if (this.failLookups) throw new Error('connection terminated unexpectedly');
    const row = this.rows.find((r) => r.provider === provider && r.providerUserId === sub);
    return row ? publicRow(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? publicRow(row) : null;
  }

  async update(id: string, patch: UpdateUserInput): Promise<UserRecord | null> {
    if (this.failUpdates) throw new Error('read-only transaction');
    this.patches.push({ id, patch });
    const idx = this.rows.findIndex((r) => r.id === id);
    const cur = this.rows[idx];
    if (!cur) return null;
    const next: Row = {
      ...cur,
      displayName: patch.displayName ?? cur.displayName,
      status: patch.status ?? cur.status,
      ...(patch.passwordHash !== undefined ? { passwordHash: patch.passwordHash } : {}),
      sessionVersion: cur.sessionVersion + (patch.revokeSessions ? 1 : 0),
    };
    this.rows[idx] = next;
    return publicRow(next);
  }

  async deleteById(id: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
  }

  async markLoginNow(): Promise<void> {
    /* fire-and-forget in the router */
  }

  async upsertOidcIdentity(input: {
    provider: string;
    providerUserId: string;
    email: string;
  }): Promise<UserRecord> {
    const existing = this.rows.find(
      (r) => r.provider === input.provider && r.providerUserId === input.providerUserId,
    );
    if (!existing) throw new Error('test fixture: seed the OIDC row first');
    return publicRow(existing);
  }

  row(provider: string, sub: string): Row {
    const row = this.rows.find((r) => r.provider === provider && r.providerUserId === sub);
    assert.ok(row, `no row ${provider}:${sub}`);
    return row;
  }
}

function seedRow(overrides: Partial<Row>): Row {
  const now = new Date();
  return {
    id: 'row-local-1',
    email: EMAIL,
    provider: 'local',
    providerUserId: EMAIL,
    displayName: 'Operator',
    role: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    sessionVersion: 0,
    ...overrides,
  };
}

function stubEntra(): OidcProvider {
  return {
    id: 'entra',
    displayName: 'Entra',
    kind: 'oidc',
    beginLogin: () => Promise.resolve({ redirectUrl: 'http://idp.invalid', pendingState: '{}' }),
    handleCallback: () =>
      Promise.resolve({
        outcome: 'success',
        providerUserId: ENTRA_SUB,
        email: ENTRA_EMAIL,
        displayName: 'Entra Operator',
      }),
    revalidateSession: () => Promise.resolve({ outcome: 'ok' }),
  };
}

interface Harness {
  base: string;
  table: UsersTable;
  forgotten: string[];
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
  table.rows.push(seedRow({ passwordHash }));
  table.rows.push(
    seedRow({ id: 'row-local-2', email: SECOND, providerUserId: SECOND, passwordHash }),
  );
  table.rows.push(
    seedRow({
      id: 'row-entra-1',
      email: ENTRA_EMAIL,
      provider: 'entra',
      providerUserId: ENTRA_SUB,
    }),
  );
  const forgotten: string[] = [];
  const userStore = table as unknown as UserStore;

  const sessions = new SessionRevocationGuard(() => undefined);
  sessions.attach(userStore);

  const registry = new ProviderRegistry();
  registry.replaceActive([new LocalPasswordProvider(userStore), stubEntra()]);
  const whitelist = new EmailWhitelist(ENTRA_EMAIL);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  // Production order: the blanket gate first, the public auth routes exempt.
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
        refreshStore: {
          forget: async (email: string) => {
            forgotten.push(email);
          },
        },
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
  app.get('/api/v1/admin/ping', (req, res) => {
    res.json({ sub: req.session?.sub });
  });

  const server = await listenLoopback(app);
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${String(port)}`, table, forgotten };
}

/** The `omadia_session` value a response sets, or null (absent or cleared). */
function sessionCookie(res: Response): string | null {
  for (const line of res.headers.getSetCookie()) {
    const match = /^omadia_session=([^;]*)/.exec(line);
    if (match) return match[1] ? match[1] : null;
  }
  return null;
}

function clearsSessionCookie(res: Response): boolean {
  return res.headers.getSetCookie().some((line) => /^omadia_session=;/.test(line));
}

async function login(h: Harness, email = EMAIL): Promise<string> {
  const res = await fetch(`${h.base}/api/v1/auth/login/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const token = sessionCookie(res);
  assert.ok(token, 'login must set a session cookie');
  return token;
}

async function call(
  h: Harness,
  method: 'GET' | 'POST',
  path: string,
  token: string,
): Promise<{ status: number; code: string | undefined; res: Response }> {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return { status: res.status, code: body.code, res };
}

describe('POST /api/v1/auth/logout ends the session server-side', () => {
  it('a cookie copied before sign-out is refused on every route afterwards (401)', async () => {
    const h = await start();
    const copied = await login(h);

    const minted = await verifySession(copied, KEY);
    assert.equal(minted.sv, 0, 'minted at the row version');
    assert.equal(minted.uid, 'row-local-1', 'bound to the verified row');
    assert.ok(minted.sid, 'every sign-in carries a session id');
    assert.equal((await call(h, 'GET', '/api/v1/admin/ping', copied)).status, 200);

    const out = await call(h, 'POST', '/api/v1/auth/logout', copied);
    assert.equal(out.status, 200);
    assert.ok(clearsSessionCookie(out.res), 'the browser cookie is cleared as before');
    assert.equal(h.table.row('local', EMAIL).sessionVersion, 1, 'the version moved on');
    assert.deepEqual(h.table.patches, [{ id: 'row-local-1', patch: { revokeSessions: true } }]);

    // The replay: the same bytes, after the sign-out.
    assert.deepEqual(
      pick(await call(h, 'GET', '/api/v1/admin/ping', copied)),
      { status: 401, code: 'auth.revoked' },
    );
    assert.deepEqual(
      pick(await call(h, 'GET', '/api/v1/auth/me', copied)),
      { status: 401, code: 'auth.revoked' },
    );
    const renew = await call(h, 'POST', '/api/v1/auth/renew', copied);
    assert.deepEqual(pick(renew), { status: 401, code: 'auth.revoked' });
    assert.equal(sessionCookie(renew.res), null, 'a revoked session cannot renew itself');
  });

  it('a new sign-in after the sign-out gets a fresh, working session', async () => {
    const h = await start();
    const first = await login(h);
    await call(h, 'POST', '/api/v1/auth/logout', first);

    const second = await login(h);
    const claims = await verifySession(second, KEY);
    assert.equal(claims.sv, 1);
    assert.notEqual(claims.sid, (await verifySession(first, KEY)).sid);
    assert.equal((await call(h, 'GET', '/api/v1/auth/me', second)).status, 200);
    assert.equal((await call(h, 'GET', '/api/v1/admin/ping', second)).status, 200);
  });

  it('a stale cookie cannot sign its owner out of their current session', async () => {
    const h = await start();
    const copied = await login(h);
    await call(h, 'POST', '/api/v1/auth/logout', copied);
    const current = await login(h);

    // /api/v1/auth/* is public, so the stale copy CAN reach /logout.
    const replay = await call(h, 'POST', '/api/v1/auth/logout', copied);
    assert.equal(replay.status, 200, 'the caller still gets its cookie cleared');
    assert.equal(h.table.row('local', EMAIL).sessionVersion, 1, 'no second bump');
    assert.equal((await call(h, 'GET', '/api/v1/admin/ping', current)).status, 200);
  });

  it('answers 200 and bumps nothing for a garbage or expired cookie', async () => {
    const h = await start();
    const expired = await signSession(
      { sub: EMAIL, email: EMAIL, display_name: 'Operator', role: 'admin', provider: 'local', sv: 0, uid: 'row-local-1' },
      KEY,
      Math.floor(Date.now() / 1000) - 60,
    );
    for (const token of ['garbage', expired]) {
      const res = await call(h, 'POST', '/api/v1/auth/logout', token);
      assert.equal(res.status, 200);
      assert.ok(clearsSessionCookie(res.res));
    }
    assert.deepEqual(h.table.patches, []);
    assert.equal(h.table.row('local', EMAIL).sessionVersion, 0);
  });

  it('still clears the cookie when the users row cannot be written', async () => {
    const h = await start();
    const token = await login(h);
    h.table.failUpdates = true;
    const res = await call(h, 'POST', '/api/v1/auth/logout', token);
    assert.equal(res.status, 200);
    assert.ok(clearsSessionCookie(res.res));
  });

  it('forgets the Entra refresh token for a current cookie, not for a stale one', async () => {
    const h = await start();
    const entra = await signSession(
      { sub: ENTRA_SUB, email: ENTRA_EMAIL, display_name: 'E', role: 'admin', provider: 'entra', sv: 0, uid: 'row-entra-1' },
      KEY,
    );
    assert.equal((await call(h, 'POST', '/api/v1/auth/logout', entra)).status, 200);
    assert.deepEqual(h.forgotten, [ENTRA_EMAIL]);
    assert.equal(h.table.row('entra', ENTRA_SUB).sessionVersion, 1);

    // The same cookie again: stale now, so it touches neither the version nor
    // a refresh token the user's next sign-in may already have stored.
    assert.equal((await call(h, 'POST', '/api/v1/auth/logout', entra)).status, 200);
    assert.deepEqual(h.forgotten, [ENTRA_EMAIL]);
    assert.equal(h.table.row('entra', ENTRA_SUB).sessionVersion, 1);
  });
});

describe('GET /api/v1/auth/me — the heartbeat sees revocations, not outages', () => {
  it('answers 503 auth.unavailable while the account cannot be read', async () => {
    const h = await start();
    const token = await login(h);
    h.table.failLookups = true;
    assert.deepEqual(pick(await call(h, 'GET', '/api/v1/auth/me', token)), {
      status: 503,
      code: 'auth.unavailable',
    });
    assert.deepEqual(pick(await call(h, 'GET', '/api/v1/admin/ping', token)), {
      status: 503,
      code: 'auth.unavailable',
    });
    h.table.failLookups = false;
    assert.equal((await call(h, 'GET', '/api/v1/auth/me', token)).status, 200);
  });
});

describe('OIDC callback — sessions are minted for the upserted row', () => {
  const pkce = `harness_auth_pkce_entra=${Buffer.from('{}').toString('base64url')}`;

  it('binds the session to the row id and its current version', async () => {
    const h = await start();
    h.table.rows = h.table.rows.map((r) =>
      r.provider === 'entra' ? { ...r, sessionVersion: 4 } : r,
    );
    const res = await fetch(`${h.base}/api/v1/auth/login/entra/cb?code=x&state=y`, {
      headers: { cookie: pkce },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    const token = sessionCookie(res);
    assert.ok(token);
    const claims = await verifySession(token, KEY);
    assert.equal(claims.sv, 4);
    assert.equal(claims.uid, 'row-entra-1');
  });

  it('refuses to mint a session for a disabled account', async () => {
    const h = await start();
    h.table.rows = h.table.rows.map((r) =>
      r.provider === 'entra' ? { ...r, status: 'disabled' } : r,
    );
    const res = await fetch(`${h.base}/api/v1/auth/login/entra/cb?code=x&state=y`, {
      headers: { cookie: pkce },
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
    assert.equal(sessionCookie(res), null);
  });
});

describe('admin actions end sessions end to end (real admin router, real gate)', () => {
  async function admin(
    h: Harness,
    token: string,
    method: 'PATCH' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<number> {
    const res = await fetch(`${h.base}/api/v1/admin/users${path}`, {
      method,
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    await res.arrayBuffer();
    return res.status;
  }

  const revoked = { status: 401, code: 'auth.revoked' };

  it('an unrelated profile edit leaves the session valid', async () => {
    const h = await start();
    const operator = await login(h);
    assert.equal(await admin(h, operator, 'PATCH', '/row-local-1', { display_name: 'Renamed' }), 200);
    assert.equal((await call(h, 'GET', '/api/v1/admin/ping', operator)).status, 200);
    assert.equal((await call(h, 'GET', '/api/v1/auth/me', operator)).status, 200);
  });

  it("a password reset ends the target's sessions at once, not the admin's", async () => {
    const h = await start();
    const operator = await login(h);
    const target = await login(h, SECOND);
    assert.equal(
      await admin(h, operator, 'POST', '/row-local-2/reset-password', { password: 'a new passphrase' }),
      200,
    );
    assert.deepEqual(pick(await call(h, 'GET', '/api/v1/admin/ping', target)), revoked);
    assert.deepEqual(pick(await call(h, 'POST', '/api/v1/auth/renew', target)), revoked);
    assert.equal((await call(h, 'GET', '/api/v1/admin/ping', operator)).status, 200);
  });

  it('disabling ends the sessions at once, and re-enabling does not revive them', async () => {
    const h = await start();
    const operator = await login(h);
    const target = await login(h, SECOND);
    assert.equal(await admin(h, operator, 'PATCH', '/row-local-2', { status: 'disabled' }), 200);
    assert.deepEqual(pick(await call(h, 'GET', '/api/v1/admin/ping', target)), revoked);

    assert.equal(await admin(h, operator, 'PATCH', '/row-local-2', { status: 'active' }), 200);
    assert.deepEqual(
      pick(await call(h, 'GET', '/api/v1/admin/ping', target)),
      revoked,
      'the cookie from before the disable stays dead',
    );
    const fresh = await login(h, SECOND);
    assert.equal((await call(h, 'GET', '/api/v1/admin/ping', fresh)).status, 200);
  });

  it('deleting the user ends the sessions at once', async () => {
    const h = await start();
    const operator = await login(h);
    const target = await login(h, SECOND);
    assert.equal(await admin(h, operator, 'DELETE', '/row-local-2'), 204);
    assert.deepEqual(pick(await call(h, 'GET', '/api/v1/admin/ping', target)), revoked);
  });

  it('resetting your own password signs you out too, everywhere', async () => {
    const h = await start();
    const here = await login(h);
    const elsewhere = await login(h);
    assert.equal(
      await admin(h, here, 'POST', '/row-local-1/reset-password', { password: 'a new passphrase' }),
      200,
    );
    assert.deepEqual(pick(await call(h, 'GET', '/api/v1/admin/ping', here)), revoked);
    assert.deepEqual(pick(await call(h, 'GET', '/api/v1/admin/ping', elsewhere)), revoked);
  });
});

function pick(r: { status: number; code: string | undefined }): { status: number; code: string | undefined } {
  return { status: r.status, code: r.code };
}
