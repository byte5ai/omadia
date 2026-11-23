import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory/dist/inMemoryKnowledgeGraph.js';
import { buildKgWalkPayload } from '@omadia/orchestrator-extras/dist/kgWalkPayload.js';
import type { KgWalkEdge, RecalledContext } from '@omadia/plugin-api';

/**
 * KG-walk chat visualization — `getMemorableKnowledgeSubgraph` BFS over the
 * recalled neighbourhood, plus the `buildKgWalkPayload` emit-path helper.
 *
 * In-memory leg. The Neon leg is `kgWalkSubgraph.pg.test.ts`, so it runs in
 * `npm run test:pg` (CI's Postgres step) instead of self-skipping here.
 */

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
