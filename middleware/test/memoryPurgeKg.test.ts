import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { Pool } from 'pg';

import { seedConversationTurn, seedTeamsIdentity } from './_helpers/conversationFixture.js';
import { probePgTest } from './_helpers/pgTestDb.js';

// ---------------------------------------------------------------------------
// WS3 — Knowledge-Graph purge primitive against a throwaway Postgres.
// Requires a reachable pgvector PG — set WS3_PG_URL (or MEMORY_PG_TEST_URL) to
// point at one. No default port: a stray container must not be picked up
// (issue #572). When no URL is set, the DB is unreachable, or it lacks
// pgvector, the suite skips (with a logged reason) rather than fails.
// ---------------------------------------------------------------------------

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
    const probe = await probePgTest({
      label: 'memoryPurgeKg',
      vars: ['WS3_PG_URL', 'MEMORY_PG_TEST_URL'],
      requireVector: true,
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 2);
    try {
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
      t.skip('pgvector Postgres not configured (set WS3_PG_URL or MEMORY_PG_TEST_URL)');
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

  // #1334 — the conversation history: Turns and everything derived from them.
  describe('purgeConversationHistory', () => {
    const ALICE = '7f1b8a52-0000-4000-8000-00000000a11c';
    const BOB = '7f1b8a52-0000-4000-8000-000000000b0b';

    async function freshGraph(p: Pool): Promise<NeonKnowledgeGraph> {
      await p.query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT]);
      const graph = new NeonKnowledgeGraph({ pool: p, tenantId: TENANT });
      // Agent a: a group chat Alice and Bob both spoke in. Agent a_b: one turn —
      // its slug shares the `a` prefix and has a LIKE wildcard in it, so a
      // sloppy prefix match would sweep it up with agent a. Plus one legacy
      // unqualified scope, which belongs to the `default` agent.
      await seedConversationTurn(graph, { scope: 'a::teams::group', time: '2026-10-01T10:00:00Z', userId: ALICE, tag: 'a1' });
      await seedConversationTurn(graph, { scope: 'a::teams::group', time: '2026-10-01T10:01:00Z', userId: BOB, tag: 'a2' });
      await seedConversationTurn(graph, { scope: 'a_b::web::chat', time: '2026-10-01T11:00:00Z', userId: BOB, tag: 'ab1' });
      await seedConversationTurn(graph, { scope: 'legacy-scope', time: '2026-10-01T12:00:00Z', tag: 'legacy' });
      // A shared node the turns never own: it must survive every purge.
      await p.query(
        `INSERT INTO graph_nodes (external_id, type, tenant_id, properties)
         VALUES ('odoo:res.partner:1', 'OdooEntity', $1, '{}'::jsonb)`,
        [TENANT],
      );
      return graph;
    }

    async function typeCounts(p: Pool): Promise<Record<string, number>> {
      const r = await p.query<{ type: string; n: number }>(
        `SELECT type, count(*)::int AS n FROM graph_nodes WHERE tenant_id = $1 GROUP BY type`,
        [TENANT],
      );
      return Object.fromEntries(r.rows.map((row) => [row.type, row.n]));
    }

    it('agent: count equals deleted, other agents and shared nodes survive', async (t) => {
      if (!reachable || !pool) {
        t.skip('pgvector Postgres not configured (set WS3_PG_URL or MEMORY_PG_TEST_URL)');
        return;
      }
      const graph = await freshGraph(pool);
      const filter = { tenantId: TENANT, agentSlug: 'a' };
      const { count } = await graph.countConversationHistory(filter);
      assert.equal(count, 17, 'two turns × 8 nodes + their session');
      const { deletedNodes } = await graph.purgeConversationHistory(filter);
      assert.equal(deletedNodes, count);

      const left = await typeCounts(pool);
      assert.equal(left['Turn'], 2, 'a_b and legacy turns stay');
      assert.equal(left['Session'], 2);
      assert.equal(left['Fact'], 2);
      assert.equal(left['OdooEntity'], 1);
      assert.equal((await graph.countConversationHistory(filter)).count, 0);
    });

    it('default agent includes the legacy unqualified scopes', async (t) => {
      if (!reachable || !pool) {
        t.skip('pgvector Postgres not configured (set WS3_PG_URL or MEMORY_PG_TEST_URL)');
        return;
      }
      const graph = await freshGraph(pool);
      const res = await graph.purgeConversationHistory({ tenantId: TENANT, agentSlug: 'default' });
      assert.equal(res.deletedNodes, 9);
      assert.equal((await typeCounts(pool))['Turn'], 3);
    });

    it("user: removes that user's turns, keeps a session another speaker still has turns in", async (t) => {
      if (!reachable || !pool) {
        t.skip('pgvector Postgres not configured (set WS3_PG_URL or MEMORY_PG_TEST_URL)');
        return;
      }
      const graph = await freshGraph(pool);
      const filter = { tenantId: TENANT, userId: BOB };
      const { count } = await graph.countConversationHistory(filter);
      // Bob's two turns (8 each) + the a_b session he alone spoke in.
      assert.equal(count, 17);
      assert.equal((await graph.purgeConversationHistory(filter)).deletedNodes, count);

      const group = await graph.getSession('a::teams::group');
      assert.equal(group?.turns.length, 1, "Alice's turn and the group session stay");
      assert.equal(await graph.getSession('a_b::web::chat'), null);
      const text = await pool.query(
        `SELECT 1 FROM graph_nodes WHERE tenant_id = $1 AND properties::text LIKE '%user message a2%'`,
        [TENANT],
      );
      assert.equal(text.rowCount, 0, "Bob's message text is gone");
    });

    it('user: a Teams user is found by omadia id although the Turn stores the AAD id', async (t) => {
      if (!reachable || !pool) {
        t.skip('pgvector Postgres not configured (set WS3_PG_URL or MEMORY_PG_TEST_URL)');
        return;
      }
      const graph = await freshGraph(pool);
      const aad = '3c9d6a10-aaaa-4bbb-8ccc-0000000ca401';
      const carol = await seedTeamsIdentity(graph, aad);
      await seedConversationTurn(graph, {
        scope: 'a::teams::dm-carol',
        time: '2026-10-02T09:00:00Z',
        userId: aad,
        runUserId: carol,
        tag: 'carol',
      });
      const filter = { tenantId: TENANT, userId: carol };
      const { count } = await graph.countConversationHistory(filter);
      assert.equal(count, 9, 'her turn (8 nodes) and her DM session');
      assert.equal((await graph.purgeConversationHistory(filter)).deletedNodes, count);
      assert.equal(await graph.getSession('a::teams::dm-carol'), null);
      const left = await typeCounts(pool);
      assert.equal(left['Turn'], 4, 'everyone else keeps their turns');
      assert.equal(left['ChannelIdentity'], 1, 'the identity itself is not conversation history');
    });

    it('a Fact or Plan without its provenance edge still goes with its Turn', async (t) => {
      if (!reachable || !pool) {
        t.skip('pgvector Postgres not configured (set WS3_PG_URL or MEMORY_PG_TEST_URL)');
        return;
      }
      const graph = await freshGraph(pool);
      // Ingested before the Turn existed: no DERIVED_FROM / PLAN_OF edge.
      const time = '2026-10-03T08:00:00Z';
      const turnId = `turn:a::web::early:${time}`;
      await graph.ingestFacts([
        { factId: 'fact:early', sourceTurnId: turnId, subject: 's', predicate: 'p', object: 'o' },
      ]);
      await graph.ingestPlan({ planId: 'plan-early', scope: 'a::web::early', turnExternalId: turnId, createdAt: time });
      const ingested = await graph.ingestTurn({
        scope: 'a::web::early', time, userMessage: 'm', assistantAnswer: 'a', entityRefs: [],
      });
      assert.equal(ingested.turnId, turnId);

      await graph.purgeConversationHistory({ tenantId: TENANT, agentSlug: 'a' });
      const left = await pool.query(
        `SELECT external_id FROM graph_nodes WHERE tenant_id = $1 AND external_id IN ('fact:early', 'plan:plan-early')`,
        [TENANT],
      );
      assert.equal(left.rowCount, 0);
    });

    it('all: the tenant has no conversation history left, shared nodes stay', async (t) => {
      if (!reachable || !pool) {
        t.skip('pgvector Postgres not configured (set WS3_PG_URL or MEMORY_PG_TEST_URL)');
        return;
      }
      const graph = await freshGraph(pool);
      const filter = { tenantId: TENANT };
      const { count } = await graph.countConversationHistory(filter);
      assert.equal(count, 35);
      assert.equal((await graph.purgeConversationHistory(filter)).deletedNodes, count);
      assert.deepEqual(await typeCounts(pool), { OdooEntity: 1 });
    });

    it('refuses a tenant the graph is not bound to', async (t) => {
      if (!reachable || !pool) {
        t.skip('pgvector Postgres not configured (set WS3_PG_URL or MEMORY_PG_TEST_URL)');
        return;
      }
      const graph = new NeonKnowledgeGraph({ pool, tenantId: TENANT });
      await assert.rejects(
        () => graph.purgeConversationHistory({ tenantId: 'other' }),
        (err: unknown) => (err as { code?: string }).code === 'tenant_mismatch',
      );
    });
  });
});
