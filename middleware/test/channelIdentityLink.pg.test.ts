/**
 * ADR-0225 — `linkChannelIdentity` on Neon, against a real pgvector Postgres
 * (`GRAPH_PG_TEST_URL`; skipped without one). Same scenarios as the
 * in-memory twin.
 */
import { after, describe, it } from 'node:test';

import { Pool } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';

import { LINK_CONTRACT } from './_helpers/channelIdentityLinkContract.js';
import { probePgTest } from './_helpers/pgTestDb.js';

const TENANT = 'adr0225-identity-link';

const { url: PG_URL, reachable: pgUp } = await probePgTest({
  label: 'channelIdentityLink',
  vars: ['GRAPH_PG_TEST_URL', 'KG_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});
const pool = pgUp ? new Pool({ connectionString: PG_URL }) : undefined;

async function wipe(p: Pool): Promise<void> {
  await p.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [TENANT]);
}

after(async () => {
  if (!pool) return;
  await wipe(pool);
  await pool.end();
});

describe('ADR-0225 · channel identity link (Neon, real PG)', () => {
  for (const [name, scenario] of LINK_CONTRACT) {
    it(name, async (t) => {
      if (!pool) return t.skip('no test database');
      await runGraphMigrations(pool);
      await wipe(pool);
      await scenario(new NeonKnowledgeGraph({ pool, tenantId: TENANT }));
    });
  }
});
