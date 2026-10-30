/**
 * #1556 follow-up — `PgFieldClassificationStore` on the real 0065 migration
 * (applied twice: idempotent). Runs in its own schema; skips cleanly when no
 * test Postgres is reachable.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { PgFieldClassificationStore } from '../src/privacy/fieldClassification/store.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'privacyFieldClassificationStore',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `privacy_field_classification_${String(process.pid)}`;

describe('#1556 field classification store against a real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: PgFieldClassificationStore;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
    const sql = await readFile(resolve(MIGRATIONS_DIR, '0065_privacy_field_classification.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    store = new PgFieldClassificationStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('merges observations, persists classification, decisions and counts', async () => {
    const base = {
      toolName: 'odoo_execute',
      scope: 'hr.employee',
      fieldPath: 'department_id',
      valueShape: 'm2o' as const,
      seenCount: 2,
      firstSeenAt: '2026-10-30T08:00:00.000Z',
      lastSeenAt: '2026-10-30T09:00:00.000Z',
    };
    await store.upsertObservation({ ...base, label: 'Department' });
    await store.upsertObservation({ ...base, lastSeenAt: '2026-10-30T10:00:00.000Z' });
    // Same field, another scope: its own candidate (one per tool + scope + field).
    await store.upsertObservation({ ...base, scope: 'sale.order' });
    const rows = await store.list();
    assert.deepEqual(rows.map((r) => r.scope), ['hr.employee', 'sale.order']);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.label, 'Department', 'a later observation without a label keeps it');
    assert.equal(row.seenCount, 4);
    assert.equal(row.lastSeenAt, '2026-10-30T10:00:00.000Z');

    await store.saveClassification(row.id, {
      relationModels: ['hr.department'],
      status: 'suggested',
      reasons: [{ code: 'known_non_personal', models: ['hr.department'] }],
      fingerprint: 'fp1',
      sampleVerdict: { sampleCount: 3, identityHit: false, c1: 'clean', hitTypes: [] },
      maskedPreview: ['•••• & ••••'],
      computedAt: '2026-10-30T11:00:00.000Z',
    });
    // An empty preview and no verdict keep what is stored.
    await store.saveClassification(row.id, {
      relationModels: ['hr.department'],
      status: 'suggested',
      reasons: [],
      fingerprint: 'fp1',
      maskedPreview: [],
      computedAt: '2026-10-30T12:00:00.000Z',
    });
    const classified = await store.get(row.id);
    assert.deepEqual(classified?.maskedPreview, ['•••• & ••••']);
    assert.equal(classified?.sampleVerdict?.sampleCount, 3);
    assert.deepEqual(await store.countOpen(), { needsClarification: 1, suggested: 1, confirmedConflict: 0 });
    assert.equal(await store.lastComputedAt(), '2026-10-30T12:00:00.000Z');

    await store.saveDecision(
      row.id,
      { action: 'reject', fingerprint: 'fp1', byId: null, byEmail: 'a@x', at: '2026-10-30T13:00:00.000Z' },
      'rejected',
    );
    const decided = await store.get(row.id);
    assert.equal(decided?.status, 'rejected');
    assert.equal(decided?.decision?.byEmail, 'a@x');
    assert.deepEqual(await store.countOpen(), { needsClarification: 1, suggested: 0, confirmedConflict: 0 });

    // The status CHECK admits confirmed_conflict, and it counts as open.
    await store.saveClassification(row.id, {
      relationModels: ['res.partner'],
      status: 'confirmed_conflict',
      reasons: [{ code: 'confirmed_conflict' }],
      fingerprint: 'fp2',
      maskedPreview: [],
      computedAt: '2026-10-30T14:00:00.000Z',
    });
    assert.deepEqual(await store.countOpen(), { needsClarification: 1, suggested: 0, confirmedConflict: 1 });
  });

  it('caches model verdicts with a TTL, and remembers visits', async () => {
    await store.saveModelVerdicts([
      { model: 'x_custom.region', verdict: 'non-personal', source: 'haiku', confidence: 0.9, reason: 'r', fieldsHash: 'abc' },
    ]);
    assert.equal((await store.modelVerdicts(['x_custom.region'], new Date(0)))[0]?.fieldsHash, 'abc');
    assert.equal(
      (await store.modelVerdicts(['x_custom.region'], new Date(Date.now() + 60_000))).length,
      0,
    );
    assert.equal(await store.lastVisit('admin'), null);
    await store.markVisit('admin', new Date('2026-10-30T14:00:00.000Z'));
    assert.equal(await store.lastVisit('admin'), '2026-10-30T14:00:00.000Z');
  });
});
