/**
 * #2042 follow-up — the human names come from REAL `users` rows: only active
 * users count, and every UserStore write invalidates the directory, so the
 * next snapshot reflects it. Runs in its own schema (search_path pinned per
 * connection) and skips cleanly when no test Postgres is configured.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';
import { agentOwnNames } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import {
  createUserHumanNameDirectory,
  type HumanNameDirectory,
} from '../src/auth/humanNameDirectory.js';
import { UserStore } from '../src/auth/userStore.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'humanNamesFromUsers',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../src/auth/migrations');
const SCHEMA = `human_names_${String(process.pid)}`;
const KAREN = { speaker: { displayName: 'Karen', slug: 'karen' } } as const;

describe('human names from the users table (real Postgres)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: UserStore;
  let directory: HumanNameDirectory;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA}` });
    for (const file of ['0001_users.sql', '0003_users_session_version.sql']) {
      await pool.query(await readFile(resolve(MIGRATIONS, file), 'utf8'));
    }
    store = new UserStore(pool);
    directory = createUserHumanNameDirectory(store);
    await directory.refresh();
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('starts with no humans: the agent keeps its own names', () => {
    assert.deepEqual(directory.snapshot(), []);
    assert.deepEqual(agentOwnNames({ ...KAREN, humanNames: directory.snapshot() }), ['Karen', 'karen']);
  });

  it('masks "Karen" once an active user "Karen Müller" is created', async () => {
    await store.create({
      email: 'karen@example.com',
      provider: 'local',
      providerUserId: 'karen@example.com',
      passwordHash: 'hash-k',
      displayName: 'Karen Müller',
    });
    await directory.refresh();
    assert.deepEqual(agentOwnNames({ ...KAREN, humanNames: directory.snapshot() }), []);
  });

  it('exempts "Karen" again when that user is disabled, and masks on re-enable', async () => {
    const karen = await store.findByEmail('local', 'karen@example.com');
    assert.ok(karen);
    await store.update(karen.id, { status: 'disabled' });
    await directory.refresh();
    assert.deepEqual(agentOwnNames({ ...KAREN, humanNames: directory.snapshot() }), ['Karen', 'karen']);

    await store.update(karen.id, { status: 'active' });
    await directory.refresh();
    assert.deepEqual(agentOwnNames({ ...KAREN, humanNames: directory.snapshot() }), []);
  });

  it('follows renames and OIDC upserts, and forgets a deleted user', async () => {
    const karen = await store.findByEmail('local', 'karen@example.com');
    assert.ok(karen);
    await store.update(karen.id, { displayName: 'Erika Muster' });
    await directory.refresh();
    assert.ok(!directory.snapshot()?.includes('Karen'));

    await store.upsertOidcIdentity({
      provider: 'entra',
      providerUserId: 'oid-1',
      email: 'k2@example.com',
      displayName: 'Karen Schulz',
    });
    await directory.refresh();
    assert.ok(directory.snapshot()?.includes('Karen'));

    const oidc = await store.findByProviderUserId('entra', 'oid-1');
    assert.ok(oidc);
    assert.equal(await store.deleteById(oidc.id), true);
    await directory.refresh();
    assert.deepEqual(directory.snapshot(), ['Erika Muster', 'Erika', 'Muster']);
  });
});
