import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { VerifierStore, type VerifierVerdict } from '@omadia/verifier';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * `verifier_verdicts.reason` (knowledge-graph migration 0034) against a
 * throwaway pgvector Postgres: the calibration query `docs/upgrading.md`
 * gives before switching from `shadow` to `enforce` runs on the rows
 * `VerifierStore` writes. `enforce` delivers `approved` and a `skipped`
 * answer whose reason is `no_trigger` / `no_claims`; it withholds every
 * other row.
 *
 * Skipping is per test, not suite-level: this file also matches the plain
 * `test/**\/*.test.ts` glob and must self-skip there without a database.
 */

const TENANT = 'verifier-store-reason';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'verifierStoreReason',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

after(async () => {
  await pool?.end();
});

const CLAIM = {
  id: 'c_1',
  text: '1.234,56 €',
  type: 'amount' as const,
  expectedSource: 'odoo' as const,
  relatedEntities: [],
};

const VERDICTS: readonly VerifierVerdict[] = [
  { status: 'approved', claims: [{ status: 'verified', claim: CLAIM, source: 'odoo' }], latencyMs: 1 },
  { status: 'skipped', reason: 'no_trigger', claims: [], latencyMs: 1 },
  { status: 'skipped', reason: 'no_claims', claims: [], latencyMs: 1 },
  { status: 'skipped', reason: 'no_checkable_claims', claims: [], latencyMs: 1 },
  { status: 'skipped', reason: 'incomplete_coverage', claims: [], latencyMs: 1 },
  { status: 'unavailable', reason: 'extractor_error', claims: [], latencyMs: 1 },
];

describe('verifier_verdicts.reason (knowledge-graph migration 0034)', () => {
  it('the shadow calibration query counts what enforce would deliver', async (t) => {
    if (pool === undefined) {
      t.skip('no test Postgres configured');
      return;
    }
    await runGraphMigrations(pool);
    await pool.query('DELETE FROM verifier_verdicts WHERE tenant = $1', [TENANT]);
    const store = new VerifierStore({ pool, tenant: TENANT, log: () => undefined });

    for (const [i, verdict] of VERDICTS.entries()) {
      await store.persist({
        input: { runId: `run-${String(i)}`, userMessage: 'Frage', answer: '' },
        verdict,
        mode: 'shadow',
        retryCount: 0,
      });
    }

    const reasons = await pool.query<{ status: string; reason: string | null }>(
      'SELECT status, reason FROM verifier_verdicts WHERE tenant = $1 ORDER BY run_id',
      [TENANT],
    );
    assert.deepEqual(
      reasons.rows.map((r) => [r.status, r.reason]),
      [
        ['approved', null],
        ['skipped', 'no_trigger'],
        ['skipped', 'no_claims'],
        ['skipped', 'no_checkable_claims'],
        ['skipped', 'incomplete_coverage'],
        ['unavailable', 'extractor_error'],
      ],
    );
    const share = await pool.query<{ delivered: number; total: number }>(
      `SELECT count(*) FILTER (
                WHERE status = 'approved'
                   OR (status = 'skipped' AND reason IN ('no_trigger', 'no_claims'))
              )::int AS delivered,
              count(*)::int AS total
         FROM verifier_verdicts
        WHERE tenant = $1`,
      [TENANT],
    );
    assert.deepEqual(share.rows[0], { delivered: 3, total: 6 });
  });
});
