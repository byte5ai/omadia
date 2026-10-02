import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';

import { LocalPasswordProvider } from '../../src/auth/providers/LocalPasswordProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import { publicPaths } from '../../src/auth/publicPaths.js';
import { createRequireAuth } from '../../src/auth/requireAuth.js';
import { verifySession } from '../../src/auth/sessionJwt.js';
import { SessionRevocationGuard } from '../../src/auth/sessionRevocation.js';
import type {
  CreateFirstAdminInput,
  FirstAdminResult,
  UpdateUserInput,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * The first-user wizard signs the new admin in, and that session has to
 * survive the server-side revocation guard like any other: the wizard stamps
 * the created row's id (`uid`) and session version (`sv`) into the cookie, so
 * the very next request is accepted and a later sign-out still ends it.
 *
 * Production shape: the real `requireAuth` at `/api` with the production
 * public-path list, the real auth router with the wizard open, one
 * `SessionRevocationGuard` attached to the same in-memory `users` table the
 * wizard writes to.
 */

const KEY = new TextEncoder().encode('S'.repeat(64));
const EMAIL = 'first-admin@example.com';
const PASSWORD = 'correct horse battery';

/** The subset of `UserStore` the wizard, the guard and `/logout` touch. */
class UsersTable {
  rows: UserRecord[] = [];

  async count(): Promise<number> {
    return this.rows.length;
  }

  async createFirstAdmin(input: CreateFirstAdminInput): Promise<FirstAdminResult> {
    if (this.rows.length > 0) return { outcome: 'not_empty', totalUsers: this.rows.length };
    const now = new Date();
    const user: UserRecord = {
      id: 'row-first-admin',
      email: input.email,
      provider: input.provider,
      providerUserId: input.providerUserId,
      displayName: input.displayName,
      role: 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      sessionVersion: 0,
    };
    this.rows.push(user);
    return { outcome: 'created', user: { ...user } };
  }

  async findByProviderUserId(provider: string, sub: string): Promise<UserRecord | null> {
    const row = this.rows.find((r) => r.provider === provider && r.providerUserId === sub);
    return row ? { ...row } : null;
  }

  async update(id: string, patch: UpdateUserInput): Promise<UserRecord | null> {
    const idx = this.rows.findIndex((r) => r.id === id);
    const cur = this.rows[idx];
    if (!cur) return null;
    const next: UserRecord = {
      ...cur,
      sessionVersion: cur.sessionVersion + (patch.revokeSessions ? 1 : 0),
    };
    this.rows[idx] = next;
    return { ...next };
  }

  async markLoginNow(): Promise<void> {
    /* fire-and-forget in the router */
  }
}

/** The `omadia_session` value a response sets, or null (absent or cleared). */
function sessionCookie(res: Response): string | null {
  for (const line of res.headers.getSetCookie()) {
    const match = /^omadia_session=([^;]*)/.exec(line);
    if (match) return match[1] ? match[1] : null;
  }
  return null;
}

describe('the first admin created by the wizard is signed in past the revocation guard', () => {
  let server: Server;
  let base: string;
  const table = new UsersTable();

  before(async () => {
    const userStore = table as unknown as UserStore;
    const sessions = new SessionRevocationGuard(() => undefined);
    sessions.attach(userStore);
    const whitelist = new EmailWhitelist(undefined);
    const registry = new ProviderRegistry();
    registry.replaceActive([new LocalPasswordProvider(userStore)]);

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
        setupAllowed: true,
        sessions,
      }),
    );
    app.get('/api/v1/admin/ping', (req, res) => {
      res.json({ sub: req.session?.sub });
    });
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('stamps the new row into the cookie, serves it, and ends it on sign-out', async () => {
    const setup = await fetch(`${base}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    assert.equal(setup.status, 200);
    const cookie = sessionCookie(setup);
    assert.ok(cookie, 'the wizard signs the new admin in');

    const row = table.rows[0];
    assert.ok(row, 'the wizard created the first admin');
    const claims = await verifySession(cookie, KEY);
    assert.equal(claims.uid, row.id, 'uid binds the session to the created row');
    assert.equal(claims.sv, row.sessionVersion, 'sv is the row version at mint time');
    assert.equal(typeof claims.sid, 'string');

    const headers = { cookie: `omadia_session=${cookie}` };
    const ping = await fetch(`${base}/api/v1/admin/ping`, { headers });
    assert.equal(ping.status, 200, 'the guard accepts the wizard session');
    assert.deepEqual(await ping.json(), { sub: EMAIL.toLowerCase() });
    const me = await fetch(`${base}/api/v1/auth/me`, { headers });
    assert.equal(me.status, 200);

    const logout = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers });
    assert.equal(logout.status, 200);
    assert.equal(table.rows[0]?.sessionVersion, 1, 'sign-out moved the version on');

    const replay = await fetch(`${base}/api/v1/admin/ping`, { headers });
    assert.equal(replay.status, 401);
    assert.equal(((await replay.json()) as { code?: string }).code, 'auth.revoked');
  });
});
