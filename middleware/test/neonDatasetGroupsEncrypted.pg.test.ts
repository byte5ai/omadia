import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { DatasetQueryValidationError } from '@omadia/plugin-api';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * #1844 / #1849 against real Postgres: grouped `query_dataset` results page
 * with `limit`/`offset` and report `totalGroups`, and a filter or `groupBy`
 * on a column holding `enc1:` cells is refused instead of matching ciphertext.
 *
 * Self-skips per test without a database (this file also matches the plain
 * `test/**\/*.test.ts` glob).
 */

const TENANT = 'neon-dataset-groups';
const OWNER = 'user-groups';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'neonDatasetGroupsEncrypted',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

let seeded: Promise<{ kg: NeonKnowledgeGraph; datasetId: string }> | undefined;

async function seed(p: Pool): Promise<{ kg: NeonKnowledgeGraph; datasetId: string }> {
  await runGraphMigrations(p);
  const kg = new NeonKnowledgeGraph({ pool: p, tenantId: TENANT });
  const rows = Array.from({ length: 250 }, (_, i) => ({
    key: `k${String(i).padStart(3, '0')}`,
    amount: i % 10,
    email: i < 3 ? `enc1:cipher${String(i)}` : `user${String(i)}@example.org`,
  }));
  const { datasetId } = await kg.ingestDataset({
    ownerOmadiaUserId: OWNER,
    name: 'groups',
    sourceFileName: 'groups.csv',
    columns: [
      { name: 'key', type: 'string' },
      { name: 'amount', type: 'number' },
      { name: 'email', type: 'string' },
    ],
    rows,
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

describe('query_dataset groups and encrypted columns · NeonKnowledgeGraph (real PG)', () => {
  it('#1844 — pages through all groups and reports totalGroups', async (t) => {
    const f = fixture();
    if (!f) return t.skip('no test database');
    const { kg, datasetId } = await f;
    const seen: unknown[] = [];
    for (const offset of [0, 200]) {
      const page = await kg.queryDatasetRows(datasetId, OWNER, {
        groupBy: 'key',
        aggregate: { fn: 'sum', column: 'amount' },
        limit: 200,
        offset,
      });
      assert.equal(page?.totalGroups, 250);
      seen.push(...(page?.groups ?? []).map((g) => g.key));
    }
    assert.equal(new Set(seen).size, 250, 'pages neither repeat nor skip a group');
    const first = await kg.queryDatasetRows(datasetId, OWNER, {
      groupBy: 'key',
      aggregate: { fn: 'sum', column: 'amount' },
      limit: 1,
    });
    assert.equal(first?.groups?.[0]?.key, 'k009', 'same order as the in-memory backend');
  });

  it('#1849 — refuses eq/contains/group_by on a column holding encrypted cells', async (t) => {
    const f = fixture();
    if (!f) return t.skip('no test database');
    const { kg, datasetId } = await f;
    for (const opts of [
      { filters: [{ column: 'email', op: 'eq' as const, value: 'user5@example.org' }] },
      { filters: [{ column: 'email', op: 'contains' as const, value: 'user' }] },
      { groupBy: 'email', aggregate: { fn: 'count' as const } },
    ]) {
      await assert.rejects(
        kg.queryDatasetRows(datasetId, OWNER, opts),
        (err: unknown) => err instanceof DatasetQueryValidationError && err.code === 'encrypted_column',
      );
    }
    const clear = await kg.queryDatasetRows(datasetId, OWNER, {
      filters: [{ column: 'key', op: 'eq', value: 'k005' }],
    });
    assert.equal(clear?.totalMatched, 1);
  });
});
