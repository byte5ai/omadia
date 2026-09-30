/**
 * `UserStore.createFirstAdmin` statement sequence, without Postgres.
 *
 * The real-database proof lives in `userStoreFirstAdmin.pg.test.ts`, which
 * skips when no test Postgres is configured. This suite runs everywhere and
 * pins the shape that makes the guarantee hold: every statement on ONE
 * client, inside one transaction, the lock wait bounded BEFORE the lock is
 * requested, the lock taken BEFORE the emptiness COUNT, and the audit row and
 * the setup-token delete committed with the INSERT. It also pins the failure
 * handling: a rollback on every error path, the pooled connection released
 * exactly once, and destroyed rather than reused when even the rollback fails.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool } from 'pg';

import { SETUP_TOKEN_SETTING_KEY } from '../../src/auth/setupToken.js';
import {
  FIRST_ADMIN_LOCK_SQL,
  FIRST_ADMIN_LOCK_WAIT_MS,
  isLockTimeout,
  UserStore,
  type CreateFirstAdminInput,
} from '../../src/auth/userStore.js';

interface Statement {
  text: string;
  values: readonly unknown[];
}

type Responder = (text: string) => { rows: unknown[] } | Error | undefined;

const INPUT: CreateFirstAdminInput = {
  email: 'Admin@Example.com',
  provider: 'local',
  providerUserId: 'admin@example.com',
  passwordHash: '$argon2id$v=19$synthetic',
  displayName: 'Admin',
  via: 'setup_wizard',
};

const USER_ROW = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'Admin@Example.com',
  provider: 'local',
  provider_user_id: 'admin@example.com',
  password_hash: '$argon2id$v=19$synthetic',
  display_name: 'Admin',
  role: 'admin',
  status: 'active',
  created_at: new Date(0),
  updated_at: new Date(0),
  last_login_at: null,
};

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A pool whose only usable path is `connect()`: `pool.query` would run on a
 *  different connection than the transaction, so it throws. */
function fakePool(respond: Responder, userCount = 0) {
  const statements: Statement[] = [];
  const releases: unknown[] = [];
  const client = {
    async query(text: string, values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
      statements.push({ text: flat(text), values });
      const scripted = respond(flat(text));
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted;
      if (flat(text).startsWith('SELECT COUNT(*)')) return { rows: [{ count: String(userCount) }] };
      if (flat(text).startsWith('INSERT INTO users')) return { rows: [USER_ROW] };
      return { rows: [] };
    },
    release(err?: unknown): void {
      releases.push(err);
    },
  };
  let connects = 0;
  const pool = {
    async connect() {
      connects += 1;
      return client;
    },
    async query(): Promise<never> {
      throw new Error('createFirstAdmin must not use pool.query — it would leave the transaction');
    },
  };
  return {
    store: new UserStore(pool as unknown as Pool),
    statements,
    releases,
    connects: () => connects,
    texts: () => statements.map((s) => s.text),
  };
}

const noScript: Responder = () => undefined;

describe('UserStore.createFirstAdmin — statement sequence', () => {
  it('created: BEGIN → bounded wait → lock → COUNT → INSERT user → audit → token delete → COMMIT', async () => {
    const f = fakePool(noScript);
    const result = await f.store.createFirstAdmin(INPUT);

    assert.equal(f.connects(), 1, 'one connection for the whole transaction');
    const texts = f.texts();
    assert.equal(texts.length, 8, texts.join('\n'));
    assert.equal(texts[0], 'BEGIN');
    assert.equal(texts[1], `SET LOCAL lock_timeout = '${String(FIRST_ADMIN_LOCK_WAIT_MS)}ms'`);
    assert.equal(texts[2], FIRST_ADMIN_LOCK_SQL);
    assert.equal(texts[3], 'SELECT COUNT(*)::text AS count FROM users');
    assert.match(texts[4] ?? '', /^INSERT INTO users /);
    assert.match(texts[5] ?? '', /^INSERT INTO admin_audit /);
    assert.equal(texts[6], 'DELETE FROM platform_settings WHERE key = $1');
    assert.equal(texts[7], 'COMMIT');

    assert.deepEqual(f.statements[4]?.values, [
      'Admin@Example.com',
      'local',
      'admin@example.com',
      '$argon2id$v=19$synthetic',
      'Admin',
      'admin',
    ]);
    const auditValues = f.statements[5]?.values ?? [];
    assert.equal(auditValues[0], USER_ROW.id, 'the wizard caller is recorded as the actor');
    assert.equal(auditValues[2], 'auth.first_admin_create');
    assert.equal(auditValues[3], `user:${USER_ROW.id}`);
    assert.match(String(auditValues[5]), /"via":"setup_wizard"/);
    assert.deepEqual(f.statements[6]?.values, [SETUP_TOKEN_SETTING_KEY]);

    assert.equal(result.outcome, 'created');
    if (result.outcome === 'created') {
      assert.equal(result.user.id, USER_ROW.id);
      assert.equal(result.user.passwordHash, undefined, 'the hash never leaves the store');
    }
    assert.deepEqual(f.releases, [undefined], 'released once, back to the pool');
  });

  it('the lock is requested after the wait is bounded and before the emptiness check', async () => {
    const f = fakePool(noScript);
    await f.store.createFirstAdmin(INPUT);
    const texts = f.texts();
    const bound = texts.findIndex((t) => t.startsWith('SET LOCAL lock_timeout'));
    const lock = texts.indexOf(FIRST_ADMIN_LOCK_SQL);
    const count = texts.findIndex((t) => t.startsWith('SELECT COUNT(*)'));
    assert.ok(bound >= 0 && lock > bound && count > lock, texts.join('\n'));
    assert.match(FIRST_ADMIN_LOCK_SQL, /SHARE ROW EXCLUSIVE/);
    assert.doesNotMatch(FIRST_ADMIN_LOCK_SQL, /ACCESS EXCLUSIVE/);
  });

  it('not_empty: the COUNT sees a user → ROLLBACK, nothing written', async () => {
    const f = fakePool(noScript, 3);
    const result = await f.store.createFirstAdmin(INPUT);
    assert.deepEqual(result, { outcome: 'not_empty', totalUsers: 3 });
    assert.deepEqual(f.texts(), [
      'BEGIN',
      `SET LOCAL lock_timeout = '${String(FIRST_ADMIN_LOCK_WAIT_MS)}ms'`,
      FIRST_ADMIN_LOCK_SQL,
      'SELECT COUNT(*)::text AS count FROM users',
      'ROLLBACK',
    ]);
    assert.deepEqual(f.releases, [undefined]);
  });

  it('lock timeout: rolls back, releases, and rethrows the 55P03 error', async () => {
    const timeout = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    const f = fakePool((text) => (text === FIRST_ADMIN_LOCK_SQL ? timeout : undefined));
    await assert.rejects(f.store.createFirstAdmin(INPUT), (err: unknown) => {
      assert.equal(err, timeout);
      assert.equal(isLockTimeout(err), true);
      return true;
    });
    assert.deepEqual(f.texts(), [
      'BEGIN',
      `SET LOCAL lock_timeout = '${String(FIRST_ADMIN_LOCK_WAIT_MS)}ms'`,
      FIRST_ADMIN_LOCK_SQL,
      'ROLLBACK',
    ]);
    assert.deepEqual(f.releases, [undefined], 'a timed-out wait leaves a healthy connection');
  });

  it('a failing audit write rolls the user back with it', async () => {
    const boom = new Error('admin_audit unavailable');
    const f = fakePool((text) => (text.startsWith('INSERT INTO admin_audit') ? boom : undefined));
    await assert.rejects(f.store.createFirstAdmin(INPUT), boom);
    const texts = f.texts();
    assert.equal(texts.at(-1), 'ROLLBACK');
    assert.ok(!texts.includes('COMMIT'), 'no admin without its audit row');
  });

  it('when even the ROLLBACK fails, the connection is destroyed, not pooled', async () => {
    const insertErr = new Error('insert failed');
    const rollbackErr = new Error('connection lost');
    const f = fakePool((text) => {
      if (text.startsWith('INSERT INTO users')) return insertErr;
      if (text === 'ROLLBACK') return rollbackErr;
      return undefined;
    });
    await assert.rejects(f.store.createFirstAdmin(INPUT), insertErr);
    assert.equal(f.releases.length, 1);
    assert.equal(f.releases[0], rollbackErr, 'release(err) tells pg to discard the client');
  });

  it('isLockTimeout is true for 55P03 only', () => {
    assert.equal(isLockTimeout({ code: '55P03' }), true);
    assert.equal(isLockTimeout({ code: '23505' }), false);
    assert.equal(isLockTimeout(new Error('boom')), false);
    assert.equal(isLockTimeout(undefined), false);
    assert.equal(isLockTimeout('55P03'), false);
  });
});
