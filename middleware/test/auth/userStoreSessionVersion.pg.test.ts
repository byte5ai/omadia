/**
 * Server-side session revocation against a real Postgres: migration 0003 on a
 * `users` table that already holds rows, the `revokeSessions` bump through the
 * real `UserStore`, and the guard's verdict over that store — including a
 * cookie minted before the `uid` claim existed, which a deleted and
 * re-created row (its `created_at` set by the database) must not revive.
 *
 * The fake-pool suite (`userStoreSessionVersion.test.ts`) pins the SQL text;
 * only a real server can prove the column name in 0003 and the one
 * `rowToRecord` reads agree, and that the bump is relative to the STORED value.
 *
 * Runs in its own schema (search_path pinned per connection), so the shared CI
 * database's other suites never see this `users` table, and skips cleanly when
 * no test Postgres is configured.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import cookieParser from 'cookie-parser';
import express from 'express';
import { SignJWT } from 'jose';
import { Pool } from 'pg';

import { listenLoopback } from '../_helpers/listenLoopback.js';
import { probePgTest } from '../_helpers/pgTestDb.js';
import { createRequireAuth, SESSION_COOKIE } from '../../src/auth/requireAuth.js';
import { SessionRevocationGuard } from '../../src/auth/sessionRevocation.js';
import { UserStore } from '../../src/auth/userStore.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'userStoreSessionVersion',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/auth/migrations');
const SCHEMA = `session_version_${String(process.pid)}`;
const KEY = new TextEncoder().encode('p'.repeat(64));

async function sql(name: string): Promise<string> {
  return readFile(resolve(MIGRATIONS, name), 'utf8');
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

/** A cookie as minted before the revocation claims existed: no sv, sid or uid. */
async function legacyCookie(email: string, signedInAt: number): Promise<string> {
  const token = await new SignJWT({ sub: email, email, display_name: 'Legacy', role: 'admin', provider: 'local' })
    .setProtectedHeader({ alg: 'HS512' })
    .setIssuer('omadia')
    .setIssuedAt(signedInAt)
    .setExpirationTime(nowS() + 3600)
    .sign(KEY);
  return `${SESSION_COOKIE}=${token}`;
}

/** Status (and refusal code) of `GET /api/ping` behind the real `requireAuth`. */
async function ping(base: string, cookie: string): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${base}/api/ping`, { headers: { cookie } });
  const body = (await res.json()) as { code?: string };
  return { status: res.status, ...(body.code ? { code: body.code } : {}) };
}

describe('users.session_version (migration 0003) against real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: UserStore;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA}` });

    // The world BEFORE 0003: a users table with a row in it.
    await pool.query(await sql('0001_users.sql'));
    await pool.query(
      `INSERT INTO users (email, provider, provider_user_id, password_hash, display_name)
       VALUES ('legacy@example.com', 'local', 'legacy@example.com', 'hash-0', 'Legacy')`,
    );
    // Applied twice: the schema CI gate re-applies every migration.
    const migration = await sql('0003_users_session_version.sql');
    await pool.query(migration);
    await pool.query(migration);
    store = new UserStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('starts every pre-existing row at version 0', async () => {
    const row = await store.findByProviderUserId('local', 'legacy@example.com');
    assert.equal(row?.sessionVersion, 0);
  });

  it('bumps the stored version together with the password, relative to itself', async () => {
    const created = await store.create({
      email: 'op@example.com',
      provider: 'local',
      providerUserId: 'op@example.com',
      passwordHash: 'hash-1',
    });
    assert.equal(created.sessionVersion, 0);

    const reset = await store.update(created.id, { passwordHash: 'hash-2', revokeSessions: true });
    assert.equal(reset?.sessionVersion, 1);
    const hash = await store.findByEmailWithHash('local', 'op@example.com');
    assert.equal(hash?.passwordHash, 'hash-2', 'the hash landed in the same statement');

    const again = await store.update(created.id, { revokeSessions: true });
    assert.equal(again?.sessionVersion, 2);

    const renamed = await store.update(created.id, { displayName: 'Renamed' });
    assert.equal(renamed?.sessionVersion, 2, 'a profile edit does not revoke');
  });

  it('decides sessions against the stored row through the guard', async () => {
    const created = await store.create({
      email: 'guard@example.com',
      provider: 'local',
      providerUserId: 'guard@example.com',
      passwordHash: 'hash-g',
    });
    const guard = new SessionRevocationGuard(() => undefined);
    guard.attach(store);
    const session = {
      provider: 'local',
      sub: 'guard@example.com',
      sv: 0,
      uid: created.id,
      auth_time: nowS(),
    };

    assert.equal(await guard.check(session), 'ok');
    await store.update(created.id, { displayName: 'Renamed' });
    assert.equal(await guard.check(session), 'ok', 'a profile edit keeps the session');
    await store.update(created.id, { revokeSessions: true });
    assert.equal(await guard.check(session), 'revoked', 'sign-out / reset');
    assert.equal(await guard.check({ ...session, sv: 1 }), 'ok', 'a token minted after it');

    await store.update(created.id, { status: 'disabled', revokeSessions: true });
    assert.equal(await guard.check({ ...session, sv: 2 }), 'revoked', 'disabled');

    await store.deleteById(created.id);
    assert.equal(await guard.check({ ...session, sv: 2 }), 'revoked', 'deleted');

    const recreated = await store.create({
      email: 'guard@example.com',
      provider: 'local',
      providerUserId: 'guard@example.com',
      passwordHash: 'hash-h',
    });
    assert.equal(recreated.sessionVersion, 0);
    assert.equal(
      await guard.check({ ...session, sv: 0 }),
      'revoked',
      'a cookie of the deleted row does not come back with the re-created one',
    );
    assert.equal(await guard.check({ ...session, sv: 0, uid: recreated.id }), 'ok');
  });

  it('a legacy cookie (no uid) gets 401 once its row is deleted and re-created', async () => {
    const email = 'legacy-cookie@example.com';
    const created = await store.create({
      email,
      provider: 'local',
      providerUserId: email,
      passwordHash: 'hash-l',
    });
    // An account from an hour ago, signed in half an hour ago by a build that
    // did not mint sv/sid/uid yet.
    await pool.query(`UPDATE users SET created_at = now() - interval '1 hour' WHERE id = $1`, [
      created.id,
    ]);
    const cookie = await legacyCookie(email, nowS() - 1800);

    const guard = new SessionRevocationGuard(() => undefined);
    guard.attach(store);
    const app = express();
    app.use(cookieParser());
    app.use(
      '/api',
      createRequireAuth({ signingKey: KEY, whitelist: new EmailWhitelist(''), sessions: guard }),
    );
    app.get('/api/ping', (_req, res) => {
      res.json({ ok: true });
    });
    const server = await listenLoopback(app);
    try {
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      assert.deepEqual(await ping(base, cookie), { status: 200 }, 'its own row vouches for it');

      await store.deleteById(created.id);
      assert.deepEqual(await ping(base, cookie), { status: 401, code: 'auth.revoked' }, 'deleted');

      // Re-created under the same identity, back at version 0 — the version
      // the legacy cookie reads as — but after that cookie's sign-in.
      const recreated = await store.create({
        email,
        provider: 'local',
        providerUserId: email,
        passwordHash: 'hash-m',
      });
      assert.equal(recreated.sessionVersion, 0);
      assert.deepEqual(
        await ping(base, cookie),
        { status: 401, code: 'auth.revoked' },
        'the re-created row does not revive the legacy cookie',
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
