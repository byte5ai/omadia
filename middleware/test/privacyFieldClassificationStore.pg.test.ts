/**
 * #1556 follow-up — `PgFieldClassificationStore` on the real 0065 + 0066
 * migrations (each applied twice: idempotent). Runs in its own schema; skips cleanly when no
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
    for (const file of ['0065_privacy_field_classification.sql', '0066_privacy_field_auto_approve.sql']) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
      await pool.query(sql);
      await pool.query(sql);
    }
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
    assert.equal(row.relationInfoKnown, false, 'not resolved before a classification');
    assert.equal(row.lastSeenAt, '2026-10-30T10:00:00.000Z');

    await store.saveClassification(row.id, {
      relationModels: ['hr.department'],
      relationInfoKnown: true,
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
      relationInfoKnown: true,
      status: 'suggested',
      reasons: [],
      fingerprint: 'fp1',
      maskedPreview: [],
      computedAt: '2026-10-30T12:00:00.000Z',
    });
    const classified = await store.get(row.id);
    assert.deepEqual(classified?.maskedPreview, ['•••• & ••••']);
    assert.equal(classified?.sampleVerdict?.sampleCount, 3);
    assert.equal(classified?.relationInfoKnown, true);
    assert.deepEqual(await store.countOpen(), { needsClarification: 1, suggested: 1, confirmedConflict: 0, autoRevoked: 0, autoApprovedNew: 0 });
    assert.equal(await store.lastComputedAt(), '2026-10-30T12:00:00.000Z');

    await store.saveDecision(
      row.id,
      { action: 'reject', fingerprint: 'fp1', byId: null, byEmail: 'a@x', at: '2026-10-30T13:00:00.000Z' },
      'rejected',
    );
    const decided = await store.get(row.id);
    assert.equal(decided?.status, 'rejected');
    assert.equal(decided?.decision?.byEmail, 'a@x');
    assert.deepEqual(await store.countOpen(), { needsClarification: 1, suggested: 0, confirmedConflict: 0, autoRevoked: 0, autoApprovedNew: 0 });

    // The status CHECK admits confirmed_conflict, and it counts as open.
    await store.saveClassification(row.id, {
      relationModels: ['res.partner'],
      relationInfoKnown: true,
      status: 'confirmed_conflict',
      reasons: [{ code: 'confirmed_conflict' }],
      fingerprint: 'fp2',
      maskedPreview: [],
      computedAt: '2026-10-30T14:00:00.000Z',
    });
    assert.deepEqual(await store.countOpen(), { needsClarification: 1, suggested: 0, confirmedConflict: 1, autoRevoked: 0, autoApprovedNew: 0 });
  });

  it('seeds a schema field once, never over an existing row, and its first sighting starts the count', async () => {
    const seed = {
      toolName: 'odoo_query',
      scope: 'hr.employee',
      fieldPath: 'job_id',
      valueShape: 'm2o' as const,
      label: 'Job Position',
      seenCount: 7,
      firstSeenAt: '2026-10-30T06:00:00.000Z',
      lastSeenAt: '2026-10-30T06:00:00.000Z',
    };
    await store.seedField(seed);
    await store.seedField({ ...seed, label: 'Other', firstSeenAt: '2026-10-30T07:00:00.000Z' });
    let row = (await store.list({ toolName: 'odoo_query' })).find((r) => r.fieldPath === 'job_id');
    assert.ok(row);
    assert.equal(row.seenCount, 0, 'a seed is never a sighting, whatever the input says');
    assert.equal(row.label, 'Job Position', 'a second seed leaves the row alone');

    await store.upsertObservation({
      ...seed,
      seenCount: 2,
      firstSeenAt: '2026-10-30T11:00:00.000Z',
      lastSeenAt: '2026-10-30T11:30:00.000Z',
    });
    row = await store.get(row.id);
    assert.equal(row?.seenCount, 2);
    assert.equal(row?.firstSeenAt, '2026-10-30T11:00:00.000Z', 'not the seed time');
    assert.equal(row?.lastSeenAt, '2026-10-30T11:30:00.000Z');

    // Seeding an observed field changes nothing.
    await store.seedField({ ...seed, label: 'Changed' });
    assert.equal((await store.get(row!.id))?.label, 'Job Position');
    assert.equal((await store.get(row!.id))?.seenCount, 2);
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

  it('0066: auto decisions, batch ids, auto statuses in the counts, bulk batches', async () => {
    await store.upsertObservation({
      toolName: 'odoo_execute',
      scope: 'sale.order',
      fieldPath: 'team_id',
      valueShape: 'm2o',
      seenCount: 1,
      firstSeenAt: '2026-10-31T08:00:00.000Z',
      lastSeenAt: '2026-10-31T08:00:00.000Z',
    });
    const row = (await store.list()).find((r) => r.scope === 'sale.order' && r.fieldPath === 'team_id')!;
    await store.markVisit('visitor', new Date('2026-10-31T09:00:00.000Z'));
    await store.saveDecision(
      row.id,
      {
        action: 'auto_approve',
        fingerprint: 'fp',
        byId: null,
        byEmail: 'system:auto-classifier',
        at: '2026-10-31T10:00:00.000Z',
      },
      'auto_approved',
    );
    const approved = await store.get(row.id);
    assert.equal(approved?.status, 'auto_approved');
    assert.equal(approved?.decision?.action, 'auto_approve');
    assert.equal(approved?.decision?.batchId, null);
    assert.equal((await store.countOpen('visitor')).autoApprovedNew, 1);
    assert.equal((await store.countOpen('nobody')).autoApprovedNew, 0);
    assert.equal((await store.countOpen()).autoApprovedNew, 0);

    await store.saveDecision(
      row.id,
      { action: 'auto_revoke', fingerprint: 'fp', byId: null, byEmail: 'system:auto-classifier', at: '2026-10-31T11:00:00.000Z' },
      'auto_revoked',
    );
    assert.equal((await store.countOpen('visitor')).autoRevoked, 1);

    const batchId = await store.createBulkBatch({
      actorId: '7b1f4a52-1111-4222-8333-444455556666',
      actorEmail: 'admin@example.com',
      entries: [{ candidateId: row.id, entry: 'odoo_execute:sale.order/team_id' }],
    });
    await store.saveDecision(
      row.id,
      { action: 'confirm', fingerprint: 'fp', byId: null, byEmail: 'admin@example.com', at: '2026-10-31T12:00:00.000Z', batchId },
      'confirmed',
    );
    assert.equal((await store.get(row.id))?.decision?.batchId, batchId);
    const latest = await store.latestOpenBulkBatch();
    assert.equal(latest?.id, batchId);
    assert.deepEqual(latest?.entries, [{ candidateId: row.id, entry: 'odoo_execute:sale.order/team_id' }]);
    const second = await store.createBulkBatch({ actorId: null, actorEmail: 'b@x', entries: [] });
    assert.equal((await store.latestOpenBulkBatch())?.id, second);
    assert.equal(await store.markBulkBatchUndone(second, 'b@x', new Date()), true);
    assert.equal(await store.markBulkBatchUndone(second, 'b@x', new Date()), false, 'once');
    assert.equal((await store.latestOpenBulkBatch())?.id, batchId);
    assert.equal((await store.getBulkBatch(second))?.undoneBy, 'b@x');

    // The CHECKs still refuse anything else.
    await assert.rejects(
      pool.query(`UPDATE privacy_field_candidates SET status = 'bogus' WHERE id = $1`, [row.id]),
    );
    await assert.rejects(
      pool.query(`UPDATE privacy_field_candidates SET decision = 'bulk' WHERE id = $1`, [row.id]),
    );
  });

  it('M1: saveDecision with an expectation is compare-and-set', async () => {
    await store.upsertObservation({
      toolName: 'odoo_execute',
      scope: 'sale.order',
      fieldPath: 'stage_id',
      valueShape: 'm2o',
      seenCount: 1,
      firstSeenAt: '2026-10-31T08:00:00.000Z',
      lastSeenAt: '2026-10-31T08:00:00.000Z',
    });
    const row = (await store.list()).find((r) => r.fieldPath === 'stage_id')!;
    await store.saveClassification(row.id, {
      relationModels: ['crm.stage'],
      relationInfoKnown: true,
      status: 'suggested',
      reasons: [],
      fingerprint: 'fp1',
      computedAt: '2026-10-31T08:00:00.000Z',
    });
    const approve = {
      action: 'auto_approve' as const,
      fingerprint: 'fp1',
      byId: null,
      byEmail: 'system:auto-classifier',
      at: '2026-10-31T10:00:00.123Z',
    };
    // Expected "no decision", but on another fingerprint: refused.
    assert.equal(await store.saveDecision(row.id, approve, 'auto_approved', { decision: null, fingerprint: 'fp0' }), false);
    assert.equal(await store.saveDecision(row.id, approve, 'auto_approved', { decision: null, fingerprint: 'fp1' }), true);
    // The same expectation again: the decision is no longer "none".
    assert.equal(await store.saveDecision(row.id, approve, 'auto_approved', { decision: null, fingerprint: 'fp1' }), false);
    const reject = { ...approve, action: 'reject' as const, byEmail: 'admin@example.com', at: '2026-10-31T11:00:00.000Z' };
    // Expected the approval but at another time: refused; with the stored one: written.
    assert.equal(
      await store.saveDecision(row.id, reject, 'rejected', {
        decision: { ...approve, at: '2026-10-31T10:00:00.000Z' },
        fingerprint: 'fp1',
      }),
      false,
    );
    const stored = (await store.get(row.id))!;
    assert.equal(
      await store.saveDecision(row.id, reject, 'rejected', { decision: stored.decision, fingerprint: 'fp1' }),
      true,
    );
    assert.equal((await store.get(row.id))?.decision?.action, 'reject');
    // Without an expectation: unconditional, as before.
    assert.equal(await store.saveDecision(row.id, null, 'suggested'), true);
  });
});
