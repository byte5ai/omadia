/**
 * `verifier_verdicts` keeps the distinction the verdict makes: a turn with
 * nothing checkable and a verifier outage persist as `skipped` /
 * `unavailable`, never as `approved`, so a calibration query can tell an
 * outage from a clean run — and with their reason, so it can tell what
 * `enforce` would deliver (`skipped` only for `no_trigger` / `no_claims`).
 * No database — a recording pool stands in.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Pool } from 'pg';
import { VerifierStore, type VerifierVerdict } from '@omadia/verifier';

interface Recorded {
  sql: string;
  params: unknown[];
}

function recordingStore(): { store: VerifierStore; queries: Recorded[]; logs: string[] } {
  const queries: Recorded[] = [];
  const logs: string[] = [];
  const pool = {
    query: (sql: string, params: unknown[]): Promise<{ rows: unknown[] }> => {
      queries.push({ sql, params });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Pool;
  const store = new VerifierStore({
    pool,
    tenant: 'tenant-a',
    log: (msg) => {
      logs.push(msg);
    },
  });
  return { store, queries, logs };
}

/** Column order of the `verifier_verdicts` INSERT in verifierStore.ts. */
const STATUS = 3;
const CLAIM_COUNT = 4;
const CONTRADICTION_COUNT = 7;
const UNVERIFIED_COUNT = 8;
const REASON = 12;

async function persisted(verdict: VerifierVerdict): Promise<{ row: unknown[]; queries: number; logs: string[] }> {
  const { store, queries, logs } = recordingStore();
  await store.persist({
    input: { runId: 'run-1', userMessage: 'Frage', answer: '' },
    verdict,
    mode: 'shadow',
    retryCount: 0,
  });
  const insert = queries.find((q) => q.sql.includes('INSERT INTO verifier_verdicts'));
  assert.ok(insert, 'a verdict row is written');
  return { row: insert.params, queries: queries.length, logs };
}

describe('VerifierStore — skipped / unavailable rows', () => {
  it('persists a skipped verdict as skipped with zero counts', async () => {
    const { row, queries } = await persisted({
      status: 'skipped',
      reason: 'no_trigger',
      claims: [],
      latencyMs: 3,
    });
    assert.equal(row[STATUS], 'skipped');
    assert.equal(row[REASON], 'no_trigger');
    assert.equal(row[CLAIM_COUNT], 0);
    assert.equal(row[CONTRADICTION_COUNT], 0);
    assert.equal(row[UNVERIFIED_COUNT], 0);
    assert.equal(queries, 1, 'no contradiction rows');
  });

  it('keeps the reason that decides what `enforce` would deliver', async () => {
    for (const reason of ['no_trigger', 'no_claims', 'no_checkable_claims', 'incomplete_coverage'] as const) {
      const { row } = await persisted({ status: 'skipped', reason, claims: [], latencyMs: 1 });
      assert.equal(row[REASON], reason);
    }
  });

  it('persists an unavailable verdict as unavailable and logs the run with its code', async () => {
    const { row, logs } = await persisted({
      status: 'unavailable',
      reason: 'extractor_error',
      claims: [],
      latencyMs: 0,
    });
    assert.equal(row[STATUS], 'unavailable');
    assert.equal(row[REASON], 'extractor_error');
    assert.equal(row[UNVERIFIED_COUNT], 0);
    assert.ok(
      logs.some((l) => l === '[verifier/store] unavailable run=run-1 reason=extractor_error'),
      `expected the outage log line, got: ${logs.join(' | ')}`,
    );
  });
});

describe('VerifierStore — counts come from the claims, not the status', () => {
  it('an approved verdict that holds an unverified claim reports it in unverified_count', async () => {
    const claim = {
      id: 'c_1',
      text: '1.234,56 €',
      type: 'amount' as const,
      expectedSource: 'odoo' as const,
      relatedEntities: [],
    };
    // Not a shape the pipeline builds, and the service binds a verdict to its
    // claims before it stores it — but the row must not hide the claim either.
    const { row } = await persisted({
      status: 'approved',
      claims: [
        { status: 'verified', claim, source: 'odoo' },
        {
          status: 'unverified',
          claim: { ...claim, id: 'c_2' },
          reason: 'no checker',
          cause: 'not_checked',
        },
      ],
      latencyMs: 2,
    });
    assert.equal(row[CLAIM_COUNT], 2);
    assert.equal(row[UNVERIFIED_COUNT], 1);
    assert.equal(row[REASON], null, 'only skipped / unavailable rows carry a reason');
  });
});
