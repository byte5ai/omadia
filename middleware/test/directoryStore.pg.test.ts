/**
 * ADR-0300 — `DirectoryStore` against a real Postgres (`GRAPH_PG_TEST_URL` /
 * `DATABASE_URL`; skipped without one), on migration 0123 in a schema of its own.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { DirectoryStore } from '../src/directory/directoryStore.js';
import { probePgTest } from './_helpers/pgTestDb.js';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'directoryStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATION = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0123_directory_people.sql');
const SCHEMA = `directory_store_${String(process.pid)}`;
const TENANT = '11111111-2222-4333-8444-555555555555';
const OID = '4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';

let pool: Pool | undefined;

before(async () => {
  if (!pgUp) return;
  const admin = new Pool({ connectionString: PG_URL });
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await admin.end();
  pool = new Pool({ connectionString: PG_URL, options: `-c search_path=${SCHEMA},public` });
  await pool.query(await readFile(MIGRATION, 'utf8'));
});

after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
  await pool.end();
});

describe('ADR-0300 · DirectoryStore (real PG)', () => {
  it('upserts, finds by object id, lists and deprovisions', async (t) => {
    if (!pool) return t.skip('no test database');
    const store = new DirectoryStore(pool);
    const run = '00000000-0000-4000-8000-000000000001';
    const { person } = await store.upsert('entra', TENANT, { externalId: OID, displayName: 'Paula', upn: 'paula@contoso.com' }, run);
    assert.equal(person.status, 'active');
    assert.equal((await store.findActiveByObjectId(OID))?.id, person.id);

    // A later change without fields keeps them.
    await store.upsert('entra', TENANT, { externalId: OID, mail: 'p@contoso.com' }, null);
    const again = await store.findById(person.id);
    assert.equal(again?.displayName, 'Paula');
    assert.equal(again?.upn, 'paula@contoso.com');
    assert.equal(again?.mail, 'p@contoso.com');

    const listed = await store.list({ search: 'paul' });
    assert.equal(listed.total, 1);
    assert.equal((await store.list({ search: '%' })).total, 0, 'LIKE wildcards are literal');

    assert.deepEqual(await store.listUnseenActive('entra', TENANT, run), []);
    assert.equal((await store.listUnseenActive('entra', TENANT, '00000000-0000-4000-8000-000000000002')).length, 1);

    await store.markDeprovisioned(person.id);
    assert.equal(await store.findActiveByObjectId(OID), null);
    assert.equal((await store.findById(person.id))?.status, 'deprovisioned');

    // A delta that only renames the person does not bring them back.
    const renamed = await store.upsert('entra', TENANT, { externalId: OID, displayName: 'Paula B.' }, null);
    assert.equal(renamed.person.status, 'deprovisioned');

    // Pending revocations are listed until cleared.
    await store.markDeprovisioned(person.id, true);
    assert.equal((await store.listRevokePending('entra', TENANT)).length, 1);
    await store.clearRevokePending(person.id);
    assert.equal((await store.listRevokePending('entra', TENANT)).length, 0);

    // Enabled again in Entra: active again.
    const back = await store.upsert('entra', TENANT, { externalId: OID, accountEnabled: true }, null);
    assert.equal(back.person.status, 'active');
    assert.equal(back.reactivated, true);
    assert.equal(back.person.deprovisionedAt, null);
  });

  it('keeps the sync cursor only for a completed run', async (t) => {
    if (!pool) return t.skip('no test database');
    const store = new DirectoryStore(pool);
    await store.markRunStarted('entra', TENANT);
    await store.markRunCompleted('entra', TENANT, 'delta-1', true);
    await store.markRunStarted('entra', TENANT);
    await store.markRunFailed('entra', TENANT, 'graph 503');
    let state = await store.getSyncState('entra', TENANT);
    assert.equal(state?.deltaCursor, 'delta-1');
    assert.equal(state?.lastError, 'graph 503');
    assert.ok(state?.lastFullAt);
    await store.markRunFailed('entra', TENANT, 'resync loop', true);
    state = await store.getSyncState('entra', TENANT);
    assert.equal(state?.deltaCursor, null);
    assert.equal((await store.listSyncStates()).length, 1);
  });

  it('a malformed id finds nobody instead of failing', async (t) => {
    if (!pool) return t.skip('no test database');
    assert.equal(await new DirectoryStore(pool).findById('not-a-uuid'), null);
  });
});
