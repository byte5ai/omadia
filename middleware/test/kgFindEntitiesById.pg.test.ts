import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import type { KnowledgeGraph } from '@omadia/plugin-api';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';

import { probePgTest } from './_helpers/pgTestDb.js';
import {
  FIND_BY_ID_ENTITIES,
  runFindEntitiesByIdContract,
} from './kgFindEntitiesByIdContract.js';

/**
 * Neon leg of the exact-id contract (`findEntities({ id })`) against a
 * throwaway pgvector Postgres, plus the one property only a shared table can
 * break: the exact-id row stays inside its tenant.
 *
 * Skipping is per test (`t.skip()` inside the contract), not suite-level:
 * this file matches the plain `test/**\/*.test.ts` glob as well as
 * `test:pg`, so it also runs in the no-database step and must self-skip
 * there without failing the suite.
 */

const TENANT = 'kg-find-by-id';
const OTHER_TENANT = 'kg-find-by-id-other';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'kgFindEntitiesById',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

let seeded:
  | Promise<{ kg: KnowledgeGraph; other: KnowledgeGraph }>
  | undefined;

async function seed(p: Pool): Promise<{ kg: KnowledgeGraph; other: KnowledgeGraph }> {
  await runGraphMigrations(p);
  for (const tenant of [TENANT, OTHER_TENANT]) {
    await p.query('DELETE FROM graph_edges WHERE tenant_id = $1', [tenant]);
    await p.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [tenant]);
  }
  const kg = new NeonKnowledgeGraph({ pool: p, tenantId: TENANT });
  const other = new NeonKnowledgeGraph({ pool: p, tenantId: OTHER_TENANT });
  await kg.ingestEntities([...FIND_BY_ID_ENTITIES]);
  // Same external id `odoo:res.partner:7`, different tenant.
  await other.ingestEntities([
    { system: 'odoo', model: 'res.partner', id: 7, displayName: 'Other Tenant Partner' },
  ]);
  return { kg, other };
}

function graphs(): Promise<{ kg: KnowledgeGraph; other: KnowledgeGraph }> | undefined {
  if (!pool) return undefined;
  seeded ??= seed(pool);
  return seeded;
}

after(async () => {
  if (!pool) return;
  for (const tenant of [TENANT, OTHER_TENANT]) {
    await pool.query('DELETE FROM graph_edges WHERE tenant_id = $1', [tenant]);
    await pool.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [tenant]);
  }
  await pool.end();
});

runFindEntitiesByIdContract('NeonKnowledgeGraph (real PG)', async () => {
  const g = graphs();
  return g ? (await g).kg : undefined;
});

describe('findEntities({ id }) — tenant scope · NeonKnowledgeGraph (real PG)', () => {
  it('resolves the id inside the calling tenant only', async (t) => {
    const g = graphs();
    if (!g) return t.skip('no test Postgres');
    const { kg, other } = await g;

    const mine = await kg.findEntities({ model: 'res.partner', id: 7 });
    const theirs = await other.findEntities({ model: 'res.partner', id: 7 });

    assert.deepEqual(
      mine.map((n) => n.props['displayName']),
      ['Partner Seven'],
    );
    assert.deepEqual(
      theirs.map((n) => n.props['displayName']),
      ['Other Tenant Partner'],
    );
  });
});
