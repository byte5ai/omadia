import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// WS3 — Knowledge-Graph purge primitive against a throwaway Postgres.
// Requires a reachable PG (pgvector). The overnight harness brings up
// `mwtest-pg-ws3` on 55433; set WS3_PG_URL to point elsewhere. If neither is
// set AND the default is unreachable, the suite skips rather than fails.
// ---------------------------------------------------------------------------

const PG_URL =
  process.env['WS3_PG_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:55433/postgres';

const TENANT = 'ws3-tenant';

let pool: Pool | undefined;
let reachable = false;

async function nodeUuid(p: Pool, externalId: string): Promise<string> {
  const r = await p.query<{ id: string }>(
    `SELECT id FROM graph_nodes WHERE tenant_id = $1 AND external_id = $2`,
    [TENANT, externalId],
  );
  return r.rows[0]!.id;
}

describe('purgeMemorableKnowledge (KG primitive)', () => {
  before(async () => {
    pool = createNeonPool(PG_URL, 2);
    try {
      await pool.query('SELECT 1');
      await runGraphMigrations(pool);
      reachable = true;
    } catch {
      reachable = false;
      await pool.end().catch(() => undefined);
      pool = undefined;
    }
  });

  after(async () => {
    if (pool) {
      await pool
        .query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  it('purges only the matching origin_agent and its incident edges', async (t) => {
    if (!reachable || !pool) {
      t.skip('Postgres not reachable (set WS3_PG_URL or start mwtest-pg-ws3)');
      return;
    }
    const p = pool;

    // Clean slate for this tenant.
    await p.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);

    // Two MemorableKnowledge nodes — origin_agent 'a' and 'b' — each with one
    // edge to a sibling User node.
    await p.query(
      `INSERT INTO graph_nodes (external_id, type, tenant_id, properties)
       VALUES
         ('mk:a', 'MemorableKnowledge', $1, '{"origin_agent":"a","acl_owners":["u1"]}'::jsonb),
         ('mk:b', 'MemorableKnowledge', $1, '{"origin_agent":"b","acl_owners":["u2"]}'::jsonb),
         ('user:u1', 'User', $1, '{}'::jsonb),
         ('user:u2', 'User', $1, '{}'::jsonb)`,
      [TENANT],
    );
    const mkA = await nodeUuid(p, 'mk:a');
    const mkB = await nodeUuid(p, 'mk:b');
    const u1 = await nodeUuid(p, 'user:u1');
    const u2 = await nodeUuid(p, 'user:u2');
    await p.query(
      `INSERT INTO graph_edges (type, from_node, to_node, tenant_id)
       VALUES ('INVOLVED', $1, $2, $5), ('INVOLVED', $3, $4, $5)`,
      [mkA, u1, mkB, u2, TENANT],
    );

    const graph = new NeonKnowledgeGraph({ pool: p, tenantId: TENANT });

    // Count before.
    const cntAll = await graph.countMemorableKnowledge({ tenantId: TENANT });
    assert.equal(cntAll.count, 2);
    const cntA = await graph.countMemorableKnowledge({
      tenantId: TENANT,
      originAgent: 'a',
    });
    assert.equal(cntA.count, 1);

    // Purge a only.
    const res = await graph.purgeMemorableKnowledge({
      tenantId: TENANT,
      originAgent: 'a',
    });
    assert.equal(res.deletedNodes, 1);

    // a's node gone, a's edge gone; b intact.
    const remaining = await p.query<{ external_id: string }>(
      `SELECT external_id FROM graph_nodes
       WHERE tenant_id = $1 AND type = 'MemorableKnowledge' ORDER BY external_id`,
      [TENANT],
    );
    assert.deepEqual(
      remaining.rows.map((r) => r.external_id),
      ['mk:b'],
    );

    const edgeA = await p.query(
      `SELECT 1 FROM graph_edges WHERE tenant_id = $1 AND from_node = $2`,
      [TENANT, mkA],
    );
    assert.equal(edgeA.rowCount, 0);

    const edgeB = await p.query(
      `SELECT 1 FROM graph_edges WHERE tenant_id = $1 AND from_node = $2`,
      [TENANT, mkB],
    );
    assert.equal(edgeB.rowCount, 1);

    // User nodes are NOT MemorableKnowledge → never deleted.
    const users = await p.query(
      `SELECT 1 FROM graph_nodes WHERE tenant_id = $1 AND type = 'User'`,
      [TENANT],
    );
    assert.equal(users.rowCount, 2);
    void mkB;
    void u2;
  });
});
