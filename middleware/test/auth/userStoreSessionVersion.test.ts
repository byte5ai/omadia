import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import { UserStore } from '../../src/auth/userStore.js';

/**
 * Server-side session revocation at the SQL layer, without a database: the
 * statements `UserStore` issues for the `session_version` marker. The real
 * column is exercised against Postgres in `userStoreSessionVersion.pg.test.ts`.
 */

interface Captured {
  text: string;
  values: unknown[];
}

const ROW = {
  id: 'row-uuid-1',
  email: 'admin@example.com',
  provider: 'local',
  provider_user_id: 'admin@example.com',
  password_hash: 'hash',
  display_name: 'Admin',
  role: 'admin',
  status: 'active',
  created_at: new Date(0),
  updated_at: new Date(0),
  last_login_at: null,
  session_version: 3,
};

function fakePool(): { pool: Pool; queries: Captured[] } {
  const queries: Captured[] = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return { rows: [ROW], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/auth/migrations/0003_users_session_version.sql',
);

describe('UserStore — session_version', () => {
  it('bumps the version in the SAME statement as a password change', async () => {
    const { pool, queries } = fakePool();
    await new UserStore(pool).update('row-uuid-1', {
      passwordHash: 'new-hash',
      revokeSessions: true,
    });
    assert.equal(queries.length, 1, 'one statement, never hash and bump apart');
    const [q] = queries;
    assert.match(q?.text ?? '', /^UPDATE users SET /);
    assert.match(q?.text ?? '', /password_hash = \$1/);
    assert.match(q?.text ?? '', /session_version = session_version \+ 1/);
    assert.match(q?.text ?? '', /WHERE id = \$2 RETURNING \*/);
    assert.deepEqual(q?.values, ['new-hash', 'row-uuid-1']);
  });

  it('issues an UPDATE when revokeSessions is the only key (no empty-patch shortcut)', async () => {
    const { pool, queries } = fakePool();
    const updated = await new UserStore(pool).update('row-uuid-1', { revokeSessions: true });
    assert.equal(queries.length, 1);
    assert.equal(
      queries[0]?.text,
      'UPDATE users SET session_version = session_version + 1 WHERE id = $1 RETURNING *',
    );
    assert.equal(updated?.sessionVersion, 3);
  });

  it('leaves the version alone for an unrelated profile update', async () => {
    const { pool, queries } = fakePool();
    await new UserStore(pool).update('row-uuid-1', { displayName: 'Renamed' });
    assert.doesNotMatch(queries[0]?.text ?? '', /session_version/);
    await new UserStore(pool).update('row-uuid-1', { revokeSessions: false, status: 'active' });
    assert.doesNotMatch(queries[1]?.text ?? '', /session_version/);
  });

  it('maps session_version onto every record it reads', async () => {
    const { pool } = fakePool();
    const store = new UserStore(pool);
    assert.equal((await store.findByProviderUserId('local', 'admin@example.com'))?.sessionVersion, 3);
    assert.equal((await store.findByEmailWithHash('local', 'admin@example.com'))?.sessionVersion, 3);
    assert.equal((await store.findById('row-uuid-1'))?.sessionVersion, 3);
  });

  it('ships an additive, re-runnable migration for the column', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    assert.match(
      sql,
      /ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;/,
    );
  });
});
