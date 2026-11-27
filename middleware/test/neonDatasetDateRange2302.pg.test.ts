import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * #2302 (ADR-0267) against real Postgres: a range filter on a `date` column
 * compares as `timestamp` (date-only = midnight, a trailing `Z` read as wall
 * clock), the same rows as the in-memory backend
 * (`datasetDateRangeFilter2302.test.ts`); a cell that is not stored ISO (a
 * column imported before #1845) is skipped instead of failing the cast.
 *
 * Self-skips per test without a database.
 */

const TENANT = 'neon-dataset-date-range';
const OWNER = 'user-date-range';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'neonDatasetDateRange2302',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

let seeded: Promise<{ kg: NeonKnowledgeGraph; datasetId: string }> | undefined;

async function seed(p: Pool): Promise<{ kg: NeonKnowledgeGraph; datasetId: string }> {
  await runGraphMigrations(p);
  const kg = new NeonKnowledgeGraph({ pool: p, tenantId: TENANT });
  const { datasetId } = await kg.ingestDataset({
    ownerOmadiaUserId: OWNER,
    name: 'invoices',
    sourceFileName: 'invoices.csv',
    columns: [
      { name: 'name', type: 'string' },
      { name: 'amount', type: 'number' },
      { name: 'due', type: 'date' },
    ],
    rows: [
      { name: 'a', amount: 1, due: '2024-03-31' },
      { name: 'b', amount: 2, due: '2024-04-19' },
      { name: 'c', amount: 3, due: '2024-04-19T10:30:00Z' },
      { name: 'd', amount: 4, due: '2024-04-30T23:59' },
      { name: 'e', amount: 5, due: '2024-12-01' },
      { name: 'f', amount: 6, due: '19.04.2024' },
      { name: 'g', amount: 7, due: null },
    ],
  });
  return { kg, datasetId };
}

function fixture(): Promise<{ kg: NeonKnowledgeGraph; datasetId: string }> | undefined {
  if (!pool) return undefined;
  seeded ??= seed(pool);
  return seeded;
}

after(async () => {
  if (!pool) return;
  const f = await seeded?.catch(() => undefined);
  if (f) await f.kg.deleteDataset(f.datasetId, { actorOmadiaUserId: OWNER });
  await pool.end();
});

describe('query_dataset date range filters · NeonKnowledgeGraph (real PG)', () => {
  it('#2302 — compares date cells as dates and skips non-ISO cells', async (t) => {
    const f = fixture();
    if (!f) return t.skip('no test database');
    const { kg, datasetId } = await f;
    const names = async (op: 'gt' | 'gte' | 'lt' | 'lte', value: string): Promise<string[]> => {
      const r = await kg.queryDatasetRows(datasetId, OWNER, { filters: [{ column: 'due', op, value }] });
      return (r?.rows ?? []).map((row) => String(row['name']));
    };
    assert.deepEqual(await names('gte', '2024-04-19'), ['b', 'c', 'd', 'e']);
    assert.deepEqual(await names('gt', '2024-04-19'), ['c', 'd', 'e']);
    assert.deepEqual(await names('lte', '2024-04-19'), ['a', 'b']);
    assert.deepEqual(await names('lt', '2024-05-01'), ['a', 'b', 'c', 'd']);
  });

  it('#2302 — a two-sided range aggregates like the in-memory backend', async (t) => {
    const f = fixture();
    if (!f) return t.skip('no test database');
    const { kg, datasetId } = await f;
    const r = await kg.queryDatasetRows(datasetId, OWNER, {
      filters: [
        { column: 'due', op: 'gte', value: '2024-04-01' },
        { column: 'due', op: 'lt', value: '2024-05-01' },
      ],
      aggregate: { fn: 'sum', column: 'amount' },
    });
    assert.equal(r?.totalMatched, 3);
    assert.equal(r?.aggregateValue, 9);
  });
});
