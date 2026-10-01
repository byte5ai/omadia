/**
 * `UserStore.createFirstAdmin` and the shared setup-token store against a real
 * Postgres.
 *
 * The first-admin guarantee is a property of the database, not of the code
 * path that calls it, so it is proven here with real transactions:
 *
 *   - N concurrent calls → exactly one `created`, the rest `not_empty`, one row;
 *   - the same email N times → still one row and no unique violation escaping;
 *   - a writer outside this code (an OIDC first-sign-in INSERT, still
 *     uncommitted) makes the call WAIT on the table lock and then see that
 *     row — the seam an advisory lock would have left open;
 *   - a lock held past `FIRST_ADMIN_LOCK_WAIT_MS` surfaces as 55P03, which
 *     `isLockTimeout` recognises;
 *   - the audit row and the consumed setup token commit with the user.
 *
 * Schema from the actual auth migrations (0001 users, 0002 audit + platform
 * settings), each applied twice, in a private `search_path`-pinned schema.
 * The table lock is per schema, so the lock-timeout case cannot stall other
 * suites; `test:pg` runs files serially regardless.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import {
  PgSetupTokenStore,
  SETUP_TOKEN_SETTING_KEY,
} from '../../src/auth/setupToken.js';
import {
  FIRST_ADMIN_LOCK_SQL,
  FIRST_ADMIN_LOCK_WAIT_MS,
  isLockTimeout,
  UserStore,
  type CreateFirstAdminInput,
  type FirstAdminResult,
} from '../../src/auth/userStore.js';
import { probePgTest } from '../_helpers/pgTestDb.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'userStoreFirstAdmin',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const AUTH_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'auth',
  'migrations',
);

const SCHEMA = `user_first_admin_${String(process.pid)}`;

/** Concurrent callers per race. */
const N = 8;

function admin(email: string): CreateFirstAdminInput {
  return {
    email,
    provider: 'local',
    providerUserId: email.toLowerCase(),
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$synthetic$synthetic',
    displayName: email,
    via: 'setup_wizard',
  };
}

function outcomes(results: FirstAdminResult[]): { created: number; notEmpty: number } {
  return {
    created: results.filter((r) => r.outcome === 'created').length,
    notEmpty: results.filter((r) => r.outcome === 'not_empty').length,
  };
}

describe('UserStore.createFirstAdmin against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: UserStore;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    // Sized above N: every concurrent call holds its own client for the
    // whole transaction, plus one for the tests' own probes.
    pool = new Pool({
      connectionString: PG_URL,
      max: N + 4,
      options: `-c search_path=${SCHEMA},public`,
    });
    for (const file of ['0001_users.sql', '0002_admin_audit.sql']) {
      const sql = await readFile(resolve(AUTH_MIGRATIONS_DIR, file), 'utf8');
      // Twice: the schema CI gate double-applies every file in the series.
      await pool.query(sql);
      await pool.query(sql);
    }
    store = new UserStore(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users, admin_audit, platform_settings');
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  async function scalar(sql: string): Promise<number> {
    const res = await pool.query<{ n: string }>(sql);
    return Number(res.rows[0]?.n ?? '0');
  }

  it(`${String(N)} concurrent calls with distinct emails create exactly one admin`, async () => {
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => store.createFirstAdmin(admin(`admin${String(i)}@example.com`))),
    );
    assert.deepEqual(outcomes(results), { created: 1, notEmpty: N - 1 });
    for (const r of results) {
      if (r.outcome === 'not_empty') assert.equal(r.totalUsers, 1);
    }
    assert.equal(await scalar('SELECT COUNT(*)::text AS n FROM users'), 1);
  });

  it(`${String(N)} concurrent calls with the same email: one admin, no unique violation`, async () => {
    // Before the table lock this was one INSERT and N-1 × 23505 thrown at the
    // caller. Now the losers never reach the INSERT.
    const results = await Promise.all(
      Array.from({ length: N }, () => store.createFirstAdmin(admin('same@example.com'))),
    );
    assert.deepEqual(outcomes(results), { created: 1, notEmpty: N - 1 });
    assert.equal(await scalar('SELECT COUNT(*)::text AS n FROM users'), 1);
  });

  it('writes the audit row and consumes a persisted setup token in the same transaction', async () => {
    await new PgSetupTokenStore(pool).claim('synthetic-setup-token-0123456789');

    const result = await store.createFirstAdmin(admin('first@example.com'));
    assert.equal(result.outcome, 'created');
    const userId = result.outcome === 'created' ? result.user.id : '';

    const audit = await pool.query<{
      actor_id: string | null;
      action: string;
      target: string;
      after: { via?: unknown; email?: unknown };
    }>('SELECT actor_id, action, target, after FROM admin_audit');
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]?.action, 'auth.first_admin_create');
    assert.equal(audit.rows[0]?.target, `user:${userId}`);
    assert.equal(audit.rows[0]?.actor_id, userId, 'the wizard caller is the new admin');
    assert.equal(audit.rows[0]?.after.via, 'setup_wizard');
    assert.equal(audit.rows[0]?.after.email, 'first@example.com');

    assert.equal(
      await scalar(`SELECT COUNT(*)::text AS n FROM platform_settings WHERE key = '${SETUP_TOKEN_SETTING_KEY}'`),
      0,
      'the setup token dies with the wizard',
    );
  });

  it('a not_empty outcome writes nothing and leaves the setup token alone', async () => {
    await store.createFirstAdmin(admin('first@example.com'));
    await pool.query('TRUNCATE admin_audit');
    await new PgSetupTokenStore(pool).claim('synthetic-setup-token-0123456789');

    const result = await store.createFirstAdmin(admin('second@example.com'));
    assert.deepEqual(result, { outcome: 'not_empty', totalUsers: 1 });
    assert.equal(await scalar('SELECT COUNT(*)::text AS n FROM admin_audit'), 0);
    assert.equal(await scalar('SELECT COUNT(*)::text AS n FROM users'), 1);
    assert.equal(
      await scalar(`SELECT COUNT(*)::text AS n FROM platform_settings WHERE key = '${SETUP_TOKEN_SETTING_KEY}'`),
      1,
      'a refused call rolls back — including the token delete',
    );
  });

  it('an env-seeded admin is audited as a system action', async () => {
    const result = await store.createFirstAdmin({ ...admin('seed@example.com'), via: 'env_seed' });
    assert.equal(result.outcome, 'created');
    const audit = await pool.query<{ actor_id: string | null; after: { via?: unknown } }>(
      'SELECT actor_id, after FROM admin_audit',
    );
    assert.equal(audit.rows[0]?.actor_id, null);
    assert.equal(audit.rows[0]?.after.via, 'env_seed');
  });

  it('waits for an uncommitted OIDC first sign-in, then reports not_empty', async () => {
    // The seam: `upsertOidcIdentity` is a bare INSERT that never goes through
    // createFirstAdmin. Its ROW EXCLUSIVE lock conflicts with the first-admin
    // transaction's SHARE ROW EXCLUSIVE, so the wizard waits for it — and the
    // COUNT it runs afterwards sees the committed IdP row.
    const holdMs = 400;
    const oidc = await pool.connect();
    try {
      await oidc.query('BEGIN');
      await oidc.query(
        `INSERT INTO users (email, provider, provider_user_id, password_hash, display_name, role)
         VALUES ('idp-user@example.com', 'entra', 'synthetic-oid-1', NULL, 'IdP User', 'admin')`,
      );

      const started = Date.now();
      const pending = store.createFirstAdmin(admin('wizard@example.com'));
      await delay(holdMs);
      await oidc.query('COMMIT');
      const result = await pending;
      const waited = Date.now() - started;

      assert.deepEqual(result, { outcome: 'not_empty', totalUsers: 1 });
      assert.ok(
        waited >= holdMs - 50,
        `createFirstAdmin must block on the uncommitted writer (returned after ${String(waited)}ms)`,
      );
    } finally {
      await oidc.query('ROLLBACK').catch(() => undefined);
      oidc.release();
    }
    assert.equal(await scalar(`SELECT COUNT(*)::text AS n FROM users WHERE provider = 'local'`), 0);
    assert.equal(await scalar('SELECT COUNT(*)::text AS n FROM users'), 1);
  });

  it(`a lock held past ${String(FIRST_ADMIN_LOCK_WAIT_MS)}ms fails fast with 55P03 (isLockTimeout)`, async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(FIRST_ADMIN_LOCK_SQL);

      const started = Date.now();
      await assert.rejects(store.createFirstAdmin(admin('late@example.com')), (err: unknown) => {
        assert.equal(isLockTimeout(err), true, `expected 55P03, got ${String(err)}`);
        return true;
      });
      const waited = Date.now() - started;
      assert.ok(
        waited >= FIRST_ADMIN_LOCK_WAIT_MS - 100 && waited < FIRST_ADMIN_LOCK_WAIT_MS + 3_000,
        `the wait is bounded by lock_timeout (took ${String(waited)}ms)`,
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    assert.equal(await scalar('SELECT COUNT(*)::text AS n FROM users'), 0);

    // SET LOCAL died with the transaction: the pooled connections are clean,
    // and the next call succeeds normally.
    const retry = await store.createFirstAdmin(admin('late@example.com'));
    assert.equal(retry.outcome, 'created');
  });
});

describe('PgSetupTokenStore against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  const schema = `${SCHEMA}_token`;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.end();
    pool = new Pool({
      connectionString: PG_URL,
      max: N + 2,
      options: `-c search_path=${schema},public`,
    });
    const sql = await readFile(resolve(AUTH_MIGRATIONS_DIR, '0002_admin_audit.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE platform_settings');
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it('replicas claiming concurrently all end up with the same token', async () => {
    const tokenStore = new PgSetupTokenStore(pool);
    const claimed = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        tokenStore.claim(`synthetic-candidate-${String(i).padStart(2, '0')}-0123456789`),
      ),
    );
    assert.equal(new Set(claimed).size, 1, `one token for every replica, got ${JSON.stringify(claimed)}`);
  });

  it('a restart keeps the stored token instead of rotating it', async () => {
    const tokenStore = new PgSetupTokenStore(pool);
    const first = await tokenStore.claim('synthetic-first-boot-0123456789');
    const second = await tokenStore.claim('synthetic-second-boot-0123456789');
    assert.equal(first, 'synthetic-first-boot-0123456789');
    assert.equal(second, first);
  });

  it('replaces an unusable stored value rather than serving it', async () => {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, '"short"'::jsonb)`,
      [SETUP_TOKEN_SETTING_KEY],
    );
    const tokenStore = new PgSetupTokenStore(pool);
    assert.equal(
      await tokenStore.claim('synthetic-replacement-0123456789'),
      'synthetic-replacement-0123456789',
    );
    assert.equal(
      await tokenStore.claim('synthetic-other-0123456789abcd'),
      'synthetic-replacement-0123456789',
    );
  });

  it('clear() forgets the token', async () => {
    const tokenStore = new PgSetupTokenStore(pool);
    await tokenStore.claim('synthetic-to-clear-0123456789');
    await tokenStore.clear();
    const res = await pool.query('SELECT 1 FROM platform_settings WHERE key = $1', [
      SETUP_TOKEN_SETTING_KEY,
    ]);
    assert.equal(res.rows.length, 0);
  });
});
