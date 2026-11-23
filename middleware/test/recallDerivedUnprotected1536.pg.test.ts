/**
 * #1536 derived recall on the Neon backend — the Postgres leg of the contract
 * in `recallDerivedUnprotected1536Contract.ts` (in-memory leg:
 * `recallDerivedUnprotected1536.test.ts`). Needs a pgvector Postgres in
 * `GRAPH_PG_TEST_URL` (or `KG_PG_TEST_URL` / `MEMORY_PG_TEST_URL`); skips
 * without one. Runs in `npm run test:pg`.
 */
import { after } from 'node:test';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';

import { probePgTest } from './_helpers/pgTestDb.js';
import { runContract, seed, VECTOR, type Seeded } from './recallDerivedUnprotected1536Contract.js';

const TENANT = 'recall-derived-1536';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'recallDerivedUnprotected1536',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;
let seeded: Promise<Seeded> | undefined;

async function clean(p: Pool): Promise<void> {
  await p.query('DELETE FROM graph_edges WHERE tenant_id = $1', [TENANT]);
  await p.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]);
}

runContract('NeonKnowledgeGraph (real PG)', async () => {
  if (!pool) return undefined;
  seeded ??= (async () => {
    await runGraphMigrations(pool);
    await clean(pool);
    const kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
    return seed(kg, async (id) => {
      await pool.query(
        'UPDATE graph_nodes SET embedding = $1::vector WHERE tenant_id = $2 AND external_id = $3',
        [`[${VECTOR.join(',')}]`, TENANT, id],
      );
    });
  })();
  return seeded;
});

after(async () => {
  if (!pool) return;
  await clean(pool);
  await pool.end();
});
