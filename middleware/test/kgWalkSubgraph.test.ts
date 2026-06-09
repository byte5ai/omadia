import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory/dist/inMemoryKnowledgeGraph.js';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import { buildKgWalkPayload } from '@omadia/orchestrator-extras/dist/kgWalkPayload.js';
import type {
  KgWalkEdge,
  KnowledgeGraph,
  RecalledContext,
} from '@omadia/plugin-api';

/**
 * KG-walk chat visualization — `getMemorableKnowledgeSubgraph` BFS over the
 * recalled neighbourhood, plus the `buildKgWalkPayload` emit-path helper.
 *
 * The Neon leg runs against a throwaway PG (mwtest-pg-kg :55439); it skips
 * cleanly when the DB is unreachable so `npm test` stays hermetic. The
 * in-memory leg always runs.
 */

const PG_URL =
  process.env['KG_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  'postgres://test:test@127.0.0.1:55439/test';

const TENANT = 'kgwalk-tenant';
const OTHER_TENANT = 'other-tenant';

// hop monotonicity from the roots: an edge's hop must be >= 1 and edges must
// appear in non-decreasing discovery order overall (every reachable node sits
// at a finite BFS distance, and an edge's hop is the nearer endpoint's
// distance + 1).
function assertHopsMonotonic(edges: KgWalkEdge[]): void {
  for (const e of edges) {
    assert.ok(e.hop >= 1, `edge hop must be >= 1, got ${e.hop}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory leg — always runs.
// ---------------------------------------------------------------------------
describe('KG-walk · InMemory getMemorableKnowledgeSubgraph', () => {
  let kg: InMemoryKnowledgeGraph;
  let rootMkId: string;
  let secondMkId: string;
  let entityId: string;
  const userA = '11111111-2222-3333-4444-555555555555';
  const userB = '99999999-8888-7777-6666-aaaaaaaaaaaa';

  before(async () => {
    kg = new InMemoryKnowledgeGraph();
    const a = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-a',
      aadObjectId: userA,
    });
    const b = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'web',
      channelUserId: 'user-b',
      aadObjectId: userB,
    });
    const ent = await kg.ingestEntities([
      { system: 'odoo', model: 'res.partner', id: 42, displayName: 'ACME' },
    ]);
    entityId = ent.entityIds[0]!;

    // Root MK — INVOLVED → userA (hop 1), REQUIRES → entity (hop 1).
    const root = await kg.createMemorableKnowledge({
      kind: 'decision',
      summary: 'Root decision about ACME',
      createdBy: 'web:user-a',
      involvedOmadiaUserIds: [a.omadiaUserId],
      requiredEntityIds: [entityId],
    });
    rootMkId = root.memorableKnowledgeNodeId;

    // Second MK — INVOLVED → userA (the SHARED neighbour) + userB.
    // From the root: root -INVOLVED-> userA (hop 1) -INVOLVED- secondMk (hop 2).
    const second = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: 'A second insight also involving user A',
      createdBy: 'web:user-b',
      involvedOmadiaUserIds: [a.omadiaUserId, b.omadiaUserId],
    });
    secondMkId = second.memorableKnowledgeNodeId;
  });

  it('returns the root + hop-1 neighbours; hops are >= 1', async () => {
    const { nodes, edges } = await kg.getMemorableKnowledgeSubgraph([rootMkId]);
    const ids = new Set(nodes.map((n) => n.id));
    assert.ok(ids.has(rootMkId), 'root present');
    assert.ok(ids.has(entityId), 'REQUIRES entity present at hop 1');
    assert.ok(edges.length > 0, 'has edges');
    assertHopsMonotonic(edges);
    // Root node carries a label from properties.summary.
    const rootNode = nodes.find((n) => n.id === rootMkId)!;
    assert.equal(rootNode.label, 'Root decision about ACME');
    assert.equal(rootNode.kind, 'MemorableKnowledge');
  });

  it('reaches the second MK at hop 2 via the shared user', async () => {
    const { nodes, edges } = await kg.getMemorableKnowledgeSubgraph([rootMkId], {
      maxHops: 2,
    });
    const ids = new Set(nodes.map((n) => n.id));
    assert.ok(ids.has(secondMkId), 'second MK reached within 2 hops');
    const hop2Edge = edges.find((e) => e.hop === 2);
    assert.ok(hop2Edge, 'an edge was discovered at hop 2');
  });

  it('respects maxHops=1 (second MK not reachable)', async () => {
    const { nodes } = await kg.getMemorableKnowledgeSubgraph([rootMkId], {
      maxHops: 1,
    });
    const ids = new Set(nodes.map((n) => n.id));
    assert.ok(!ids.has(secondMkId), 'second MK excluded at maxHops=1');
  });

  it('respects maxNodes cap', async () => {
    const { nodes } = await kg.getMemorableKnowledgeSubgraph([rootMkId], {
      maxHops: 4,
      maxNodes: 2,
    });
    assert.ok(nodes.length <= 2, `cap honoured, got ${nodes.length}`);
  });

  it('empty roots → empty payload', async () => {
    const { nodes, edges } = await kg.getMemorableKnowledgeSubgraph([]);
    assert.equal(nodes.length, 0);
    assert.equal(edges.length, 0);
  });

  it('buildKgWalkPayload stamps recall scores on root nodes', async () => {
    const recalled: RecalledContext = {
      plans: [],
      processes: [],
      insights: [
        { mkId: rootMkId, kind: 'decision', summary: 'x', score: 0.87 },
      ],
    };
    const payload = await buildKgWalkPayload(recalled, kg);
    assert.ok(payload, 'payload built for non-empty recall');
    assert.deepEqual(payload!.rootIds, [rootMkId]);
    const rootNode = payload!.nodes.find((n) => n.id === rootMkId)!;
    assert.equal(rootNode.score, 0.87, 'root score stamped from recall hit');
    // Non-root nodes carry no score.
    const entNode = payload!.nodes.find((n) => n.id === entityId);
    assert.equal(entNode?.score, undefined);
  });

  it('buildKgWalkPayload returns undefined for empty recall', async () => {
    const empty: RecalledContext = { plans: [], processes: [], insights: [] };
    assert.equal(await buildKgWalkPayload(empty, kg), undefined);
    assert.equal(await buildKgWalkPayload(undefined, kg), undefined);
  });
});

// ---------------------------------------------------------------------------
// Neon leg — throwaway PG, skips when unreachable.
// ---------------------------------------------------------------------------
let pgUp = false;
const probePool = new Pool({
  connectionString: PG_URL,
  connectionTimeoutMillis: 2000,
});
try {
  await probePool.query('SELECT 1');
  pgUp = true;
} catch {
  console.error(`[kgWalkSubgraph] PG at ${PG_URL} unreachable — skipping Neon leg`);
}

if (pgUp) {
  const pool = probePool;

  after(async () => {
    await pool.end();
  });

  describe('KG-walk · Neon getMemorableKnowledgeSubgraph (real PG)', () => {
    let kg: KnowledgeGraph;

    // External ids for the hand-seeded subgraph.
    const root = 'mk:root';
    const turn = 'turn:kgwalk:t1';
    const user = 'user:u1';
    const entity = 'odoo:res.partner:7';
    const sibling = 'mk:sibling'; // shares the Turn → reachable at hop 2
    const otherTenantMk = 'mk:other-tenant';

    before(async () => {
      await runGraphMigrations(pool);
      kg = new NeonKnowledgeGraph({ pool, tenantId: TENANT });

      // Clean prior runs (idempotent).
      await pool.query(`DELETE FROM graph_edges WHERE tenant_id = ANY($1)`, [
        [TENANT, OTHER_TENANT],
      ]);
      await pool.query(`DELETE FROM graph_nodes WHERE tenant_id = ANY($1)`, [
        [TENANT, OTHER_TENANT],
      ]);

      const node = async (
        tenant: string,
        extId: string,
        type: string,
        props: Record<string, unknown>,
      ): Promise<string> => {
        const r = await pool.query<{ id: string }>(
          `INSERT INTO graph_nodes (external_id, type, tenant_id, properties)
           VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
          [extId, type, tenant, JSON.stringify(props)],
        );
        return r.rows[0]!.id;
      };
      const edge = async (
        tenant: string,
        from: string,
        to: string,
        type: string,
      ): Promise<void> => {
        await pool.query(
          `INSERT INTO graph_edges (type, from_node, to_node, tenant_id)
           VALUES ($1, $2, $3, $4)`,
          [type, from, to, tenant],
        );
      };

      const rootU = await node(TENANT, root, 'MemorableKnowledge', {
        summary: 'Root MK summary',
      });
      const turnU = await node(TENANT, turn, 'Turn', { time: '2026-01-01' });
      const userU = await node(TENANT, user, 'User', { name: 'Alice' });
      const entU = await node(TENANT, entity, 'OdooEntity', {
        displayName: 'Partner 7',
      });
      const sibU = await node(TENANT, sibling, 'MemorableKnowledge', {
        summary: 'Sibling MK',
      });

      // root -DERIVED_FROM-> turn (hop1), root -INVOLVED-> user (hop1),
      // root -REQUIRES-> entity (hop1). sibling -DERIVED_FROM-> turn so the
      // walk reaches sibling at hop 2 (root -> turn -> sibling).
      await edge(TENANT, rootU, turnU, 'DERIVED_FROM');
      await edge(TENANT, rootU, userU, 'INVOLVED');
      await edge(TENANT, rootU, entU, 'REQUIRES');
      await edge(TENANT, sibU, turnU, 'DERIVED_FROM');

      // Cross-tenant decoy — must NEVER appear in TENANT's walk.
      const otherU = await node(
        OTHER_TENANT,
        otherTenantMk,
        'MemorableKnowledge',
        { summary: 'Other tenant MK' },
      );
      const otherTurn = await node(OTHER_TENANT, turn, 'Turn', {});
      await edge(OTHER_TENANT, otherU, otherTurn, 'DERIVED_FROM');
    });

    it('BFS returns root + hop-1 neighbours, hop numbers correct, tenant-scoped', async () => {
      const { nodes, edges } = await kg.getMemorableKnowledgeSubgraph([root]);
      const ids = new Set(nodes.map((n) => n.id));
      assert.ok(ids.has(root), 'root present');
      assert.ok(ids.has(turn), 'turn at hop 1');
      assert.ok(ids.has(user), 'user at hop 1');
      assert.ok(ids.has(entity), 'entity at hop 1');
      assert.ok(!ids.has(otherTenantMk), 'cross-tenant node excluded');

      assertHopsMonotonic(edges);
      const hop1Edges = edges.filter((e) => e.hop === 1);
      assert.ok(hop1Edges.length >= 3, 'three hop-1 edges from the root');

      // Labels resolved from properties.
      assert.equal(
        nodes.find((n) => n.id === root)!.label,
        'Root MK summary',
      );
      assert.equal(
        nodes.find((n) => n.id === entity)!.label,
        'Partner 7',
      );
    });

    it('reaches the sibling MK at hop 2 via the shared Turn', async () => {
      const { nodes, edges } = await kg.getMemorableKnowledgeSubgraph([root], {
        maxHops: 2,
      });
      const ids = new Set(nodes.map((n) => n.id));
      assert.ok(ids.has(sibling), 'sibling reached at hop 2');
      assert.ok(
        edges.some((e) => e.hop === 2),
        'an edge discovered at hop 2',
      );
    });

    it('respects maxHops=1 (sibling unreachable)', async () => {
      const { nodes } = await kg.getMemorableKnowledgeSubgraph([root], {
        maxHops: 1,
      });
      assert.ok(
        !new Set(nodes.map((n) => n.id)).has(sibling),
        'sibling excluded at maxHops=1',
      );
    });

    it('respects maxNodes cap and stays internally consistent', async () => {
      const { nodes, edges } = await kg.getMemorableKnowledgeSubgraph([root], {
        maxHops: 3,
        maxNodes: 2,
      });
      assert.ok(nodes.length <= 2, `cap honoured, got ${nodes.length}`);
      // Every emitted edge references two emitted nodes (no dangling).
      const ids = new Set(nodes.map((n) => n.id));
      for (const e of edges) {
        assert.ok(ids.has(e.from) && ids.has(e.to), 'edge endpoints emitted');
      }
    });

    it('unknown roots → empty payload', async () => {
      const { nodes, edges } = await kg.getMemorableKnowledgeSubgraph([
        'mk:does-not-exist',
      ]);
      assert.equal(nodes.length, 0);
      assert.equal(edges.length, 0);
    });

    it('buildKgWalkPayload emits a payload from a non-empty recall', async () => {
      const recalled: RecalledContext = {
        plans: [],
        processes: [],
        insights: [
          { mkId: root, kind: 'decision', summary: 'x', score: 0.5 },
        ],
      };
      const payload = await buildKgWalkPayload(recalled, kg);
      assert.ok(payload, 'payload present');
      assert.deepEqual(payload!.rootIds, [root]);
      assert.equal(
        payload!.nodes.find((n) => n.id === root)!.score,
        0.5,
        'recall score stamped on root',
      );
    });
  });
}
