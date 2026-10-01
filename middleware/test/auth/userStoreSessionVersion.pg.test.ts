/**
 * Server-side session revocation against a real Postgres: migration 0003 on a
 * `users` table that already holds rows, the `revokeSessions` bump through the
 * real `UserStore`, and the guard's verdict over that store.
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
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from '../_helpers/pgTestDb.js';
import { SessionRevocationGuard } from '../../src/auth/sessionRevocation.js';
import { UserStore } from '../../src/auth/userStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'userStoreSessionVersion',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/auth/migrations');
const SCHEMA = `session_version_${String(process.pid)}`;

async function sql(name: string): Promise<string> {
  return readFile(resolve(MIGRATIONS, name), 'utf8');
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
    const session = { provider: 'local', sub: 'guard@example.com', sv: 0, uid: created.id };

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
});
