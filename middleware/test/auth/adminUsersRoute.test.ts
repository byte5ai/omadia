import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { AdminAuditLog, type AuditEntry } from '../../src/auth/adminAuditLog.js';
import { LOCAL_PROVIDER_ID } from '../../src/auth/providers/LocalPasswordProvider.js';
import { hashPassword } from '../../src/auth/passwordHasher.js';
import type {
  CreateUserInput,
  UpdateUserInput,
  UserRecord,
  UserStore,
} from '../../src/auth/userStore.js';
import { createAdminUsersRouter } from '../../src/routes/adminUsers.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * Postgres-free integration test for the admin-users router. Stubs out
 * UserStore + AdminAuditLog with in-memory equivalents that mirror the
 * real shapes the router relies on, then drives the router via real
 * Express + fetch — same pattern as profilesRouter.test.ts.
 *
 * Session injection: the router reads `req.session` from the upstream
 * `requireAuth` gate; here we forge a session via a per-request middleware
 * the test toggles before each call. Self-lock-out then becomes "the
 * forged session matches the target row".
 */

class InMemoryUserStore {
  rows: UserRecord[] = [];

  async count(): Promise<number> {
    return this.rows.length;
  }
  async findById(id: string): Promise<UserRecord | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async findByEmail(provider: string, email: string): Promise<UserRecord | null> {
    return (
      this.rows.find(
        (r) => r.provider === provider && r.email.toLowerCase() === email.toLowerCase(),
      ) ?? null
    );
  }
  async findByProviderUserId(
    provider: string,
    providerUserId: string,
  ): Promise<UserRecord | null> {
    return (
      this.rows.find(
        (r) => r.provider === provider && r.providerUserId === providerUserId,
      ) ?? null
    );
  }
  async list(opts: { limit?: number; offset?: number } = {}): Promise<UserRecord[]> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    return this.rows.slice(offset, offset + limit);
  }
  async create(input: CreateUserInput): Promise<UserRecord> {
    const now = new Date();
    const row: UserRecord = {
      id: `mock-${this.rows.length + 1}`,
      email: input.email,
      provider: input.provider,
      providerUserId: input.providerUserId,
      displayName: input.displayName ?? '',
      role: input.role ?? 'admin',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    if (input.passwordHash !== undefined) {
      (row as UserRecord & { passwordHash?: string }).passwordHash = input.passwordHash;
    }
    this.rows.push(row);
    return row;
  }
  async update(id: string, patch: UpdateUserInput): Promise<UserRecord | null> {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    const cur = this.rows[idx]!;
    const next: UserRecord = {
      ...cur,
      displayName: patch.displayName ?? cur.displayName,
      role: patch.role ?? cur.role,
      status: patch.status ?? cur.status,
      updatedAt: new Date(),
    };
    this.rows[idx] = next;
    return next;
  }
  async deleteById(id: string): Promise<boolean> {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.rows.splice(idx, 1);
    return true;
  }
}

class InMemoryAuditLog {
  entries: AuditEntry[] = [];
  async record(input: {
    actor: { id?: string; email?: string };
    action: string;
    target: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    this.entries.push({
      id: `audit-${this.entries.length + 1}`,
      actorId: input.actor.id ?? null,
      actorEmail: input.actor.email ?? null,
      action: input.action,
      target: input.target,
      before: input.before ?? null,
      after: input.after ?? null,
      createdAt: new Date(),
    });
  }
}

interface ForgedSession {
  sub: string;
  email: string;
  display_name: string;
  role: 'admin';
  provider: string;
}

describe('/api/v1/admin/users router', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  let store: InMemoryUserStore;
  let audit: InMemoryAuditLog;
  let session: ForgedSession | null;
  /** Account keys the router asked the sign-in limiter to forget (§10f unlock). */
  let clearedAccounts: string[];
  /** Account keys whose device-cookie epoch the router asked to re-read (§10f revocation). */
  let forgottenAccounts: string[];

  before(async () => {
    store = new InMemoryUserStore();
    audit = new InMemoryAuditLog();
    session = null;
    clearedAccounts = [];
    forgottenAccounts = [];

    // Pre-seed an existing local admin so list/edit/delete tests have a
    // target without exercising create-side every time.
    const seedHash = await hashPassword('seed-pass-1');
    await store.create({
      email: 'admin@example.com',
      provider: LOCAL_PROVIDER_ID,
      providerUserId: 'admin@example.com',
      passwordHash: seedHash,
      displayName: 'Admin One',
      role: 'admin',
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (session) (req as express.Request).session = session;
      next();
    });
    app.use(
      '/api/v1/admin/users',
      createAdminUsersRouter({
        userStore: store as unknown as UserStore,
        audit: audit as unknown as AdminAuditLog,
        loginLimiter: {
          clearAccount: (accountKey: string) => {
            clearedAccounts.push(accountKey);
          },
        },
        loginDevices: {
          forget: (accountKey: string) => {
            forgottenAccounts.push(accountKey);
          },
        },
      }),
    );
    server = await listenLoopback(app);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function setSession(s: ForgedSession | null): void {
    session = s;
  }

  function adminSession(provider = LOCAL_PROVIDER_ID, sub = 'admin@example.com'): ForgedSession {
    return {
      sub,
      email: 'admin@example.com',
      display_name: 'Admin One',
      role: 'admin',
      provider,
    };
  }

  it('GET / lists users', async () => {
    setSession(adminSession());
    const res = await fetch(`${baseUrl}/api/v1/admin/users`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      users: Array<{ id: string; email: string }>;
    };
    assert.equal(body.users.length >= 1, true);
    assert.equal(body.users[0]?.email, 'admin@example.com');
  });

  it('POST / creates a local user, hashes the password, audits', async () => {
    setSession(adminSession());
    const before = audit.entries.length;
    const forgottenBefore = forgottenAccounts.length;
    const res = await fetch(`${baseUrl}/api/v1/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'new@example.com',
        password: 'pw-newuser-1',
        display_name: 'New User',
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { user: { id: string; email: string } };
    assert.equal(body.user.email, 'new@example.com');
    assert.equal(audit.entries.length, before + 1);
    assert.equal(audit.entries.at(-1)?.action, 'user.create');
    assert.deepEqual(
      forgottenAccounts.slice(forgottenBefore),
      ['local:new@example.com'],
      'no cached "no such account" outlives the create',
    );
  });

  it('POST / rejects duplicate email with 409', async () => {
    setSession(adminSession());
    const res = await fetch(`${baseUrl}/api/v1/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'pw-newuser-1',
      }),
    });
    assert.equal(res.status, 409);
  });

  it('POST / rejects short password with 400', async () => {
    setSession(adminSession());
    const res = await fetch(`${baseUrl}/api/v1/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'tiny@example.com', password: 'short' }),
    });
    assert.equal(res.status, 400);
  });

  it('PATCH /:id updates display_name + audits', async () => {
    setSession(adminSession());
    const forgottenBefore = forgottenAccounts.length;
    const target = store.rows.find((r) => r.email === 'new@example.com')!;
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${target.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Renamed' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user: { display_name: string } };
    assert.equal(body.user.display_name, 'Renamed');
    assert.equal(audit.entries.at(-1)?.action, 'user.update');
    assert.deepEqual(clearedAccounts, [], 'a rename does not touch the sign-in limiter');
    assert.equal(forgottenAccounts.length, forgottenBefore, 'nor the device cookies');
  });

  it('PATCH /:id refuses to disable yourself with 409 self_lockout', async () => {
    setSession(adminSession());
    const forgottenBefore = forgottenAccounts.length;
    const self = store.rows.find((r) => r.email === 'admin@example.com')!;
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${self.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'admin_users.self_lockout');
    assert.equal(forgottenAccounts.length, forgottenBefore, 'a refused change revokes nothing');
  });

  it('PATCH /:id allows disabling someone else', async () => {
    setSession(adminSession());
    const forgottenBefore = forgottenAccounts.length;
    const other = store.rows.find((r) => r.email === 'new@example.com')!;
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${other.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user: { status: string } };
    assert.equal(body.user.status, 'disabled');
    assert.deepEqual(clearedAccounts, [], 'disabling is not an unlock');
    assert.deepEqual(
      forgottenAccounts.slice(forgottenBefore),
      ['local:new@example.com'],
      'but its device cookies stop counting at once',
    );
  });

  it('PATCH /:id re-enabling a user clears their sign-in backoff (operator unlock)', async () => {
    setSession(adminSession());
    const other = store.rows.find((r) => r.email === 'new@example.com')!;
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${other.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(clearedAccounts, ['local:new@example.com']);
    assert.equal(forgottenAccounts.at(-1), 'local:new@example.com');
  });

  it('POST /:id/reset-password updates the hash + audits without leaking material', async () => {
    setSession(adminSession());
    const before = audit.entries.length;
    const forgottenBefore = forgottenAccounts.length;
    const target = store.rows.find((r) => r.email === 'new@example.com')!;
    const res = await fetch(
      `${baseUrl}/api/v1/admin/users/${target.id}/reset-password`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'pw-resetted-1' }),
      },
    );
    assert.equal(res.status, 200);
    assert.equal(audit.entries.length, before + 1);
    const last = audit.entries.at(-1)!;
    assert.equal(last.action, 'user.reset_password');
    assert.equal(last.before, null);
    assert.equal(last.after, null);
    assert.equal(clearedAccounts.at(-1), 'local:new@example.com');
    assert.deepEqual(
      forgottenAccounts.slice(forgottenBefore),
      ['local:new@example.com'],
      'the new hash revokes the account’s device cookies',
    );
  });

  it('POST /:id/reset-password clears the backoff under the folded (lower-cased) account key', async () => {
    setSession(adminSession());
    const mixed = await store.create({
      email: 'Mixed.Case@Example.com',
      provider: LOCAL_PROVIDER_ID,
      providerUserId: 'mixed.case@example.com',
      passwordHash: await hashPassword('seed-pass-2'),
      displayName: 'Mixed',
      role: 'admin',
    });
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${mixed.id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw-resetted-2' }),
    });
    assert.equal(res.status, 200);
    assert.equal(clearedAccounts.at(-1), 'local:mixed.case@example.com');
  });

  it('POST /:id/reset-password unlocks every spelling but revokes only this account’s cookies', async () => {
    setSession(adminSession());
    const accented = await store.create({
      email: '\u00c9lise.Dupont@Example.com',
      provider: LOCAL_PROVIDER_ID,
      providerUserId: '\u00e9lise.dupont@example.com',
      passwordHash: await hashPassword('seed-pass-3'),
      displayName: '\u00c9lise',
      role: 'admin',
    });
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${accented.id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw-resetted-3' }),
    });
    assert.equal(res.status, 200);
    // Two identities (§10f): the limiter's bucket folds the address, the
    // device cookies are bound to the address as stored, ASCII case aside.
    assert.equal(clearedAccounts.at(-1), 'local:elise.dupont@example.com');
    assert.equal(forgottenAccounts.at(-1), 'local:\u00c9lise.dupont@example.com');
  });

  it('POST /:id/reset-password with a too-short password does not unlock', async () => {
    setSession(adminSession());
    const cleared = clearedAccounts.length;
    const forgotten = forgottenAccounts.length;
    const target = store.rows.find((r) => r.email === 'new@example.com')!;
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${target.id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'short' }),
    });
    assert.equal(res.status, 400);
    assert.equal(clearedAccounts.length, cleared);
    assert.equal(forgottenAccounts.length, forgotten, 'nor revokes anything');
  });

  it('DELETE /:id refuses self-delete with 409', async () => {
    setSession(adminSession());
    const self = store.rows.find((r) => r.email === 'admin@example.com')!;
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${self.id}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 409);
  });

  it('DELETE /:id removes another user + audits', async () => {
    setSession(adminSession());
    const other = store.rows.find((r) => r.email === 'new@example.com')!;
    const res = await fetch(`${baseUrl}/api/v1/admin/users/${other.id}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
    assert.equal(store.rows.find((r) => r.id === other.id), undefined);
    assert.equal(audit.entries.at(-1)?.action, 'user.delete');
    assert.equal(forgottenAccounts.at(-1), 'local:new@example.com', 'its device cookies with it');
  });
});
