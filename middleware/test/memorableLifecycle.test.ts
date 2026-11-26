/**
 * ADR-0190 — memorable-knowledge lifecycle (DB-less, in-memory backend and
 * the detectors):
 *  - #1819 deleting an entry retires its source turns from promotion;
 *  - #1862 deleting closes the entry's open pairs, and a resolution that
 *    keeps a deleted side is refused;
 *  - #1835 auto-merge resolves only near-exact pairs, never deletes a
 *    hand-saved entry, and audits as the system with the cosine;
 *  - #1861 a lost contradiction verdict leaves the entry unchecked;
 *  - #1864 a turn no person owns is skipped, not failed.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/embeddings';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  createInconsistencyDetector,
  createMergeCandidateDetector,
} from '@omadia/orchestrator-extras';
import { JUDGEMENT_MAX_TOKENS } from '@omadia/orchestrator-extras/dist/inconsistencyDetector.js';
import { promoteTurnIfSignificant } from '@omadia/orchestrator-extras/dist/promotion.js';
import { agentOfTurnScope } from '@omadia/orchestrator-extras/dist/bulkPromotion.js';
import {
  PROMOTION_RETIRED_PROP,
  SYSTEM_AUDIT_ACTOR_UUID,
  type GraphNode,
  type KnowledgeGraph,
} from '@omadia/plugin-api';

const OWNER = '11111111-1111-4111-8111-111111111111';
const VEC: number[] = [1, 0, 0, 0];

const embedder: EmbeddingClient = {
  async embed(): Promise<number[]> {
    return [...VEC];
  },
};

async function seedMk(
  kg: InMemoryKnowledgeGraph,
  summary: string,
  createdBy: string,
  extra: { derivedFromTurnIds?: string[] } = {},
): Promise<string> {
  const created = await kg.createMemorableKnowledge({
    kind: 'reference',
    summary,
    createdBy,
    involvedOmadiaUserIds: [],
    aclOwners: [OWNER],
    ...extra,
  });
  kg.setEmbedding(created.memorableKnowledgeNodeId, VEC);
  return created.memorableKnowledgeNodeId;
}

/** The backend's raw node (the in-memory store has no public node read). */
function rawNode(kg: InMemoryKnowledgeGraph, id: string): GraphNode | undefined {
  return (kg as unknown as { nodes: Map<string, GraphNode> }).nodes.get(id);
}

function turnProps(kg: InMemoryKnowledgeGraph, turnId: string): Record<string, unknown> {
  const node = rawNode(kg, turnId);
  assert.ok(node, `turn ${turnId} exists`);
  return node.props;
}

describe('ADR-0190 · delete retires the source turn (#1819)', () => {
  it('marks the DERIVED_FROM turn retired from promotion', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const { turnId } = await kg.ingestTurn({
      scope: 'default::talk-a',
      userId: OWNER,
      time: '2026-11-10T09:00:00.000Z',
      userMessage: 'Projekt Zebra startet am 10. November.',
      assistantAnswer: 'Notiert: Projekt Zebra startet am 10. November.',
      entityRefs: [],
    });
    const mk = await seedMk(kg, 'Projekt Zebra startet am 10. November.', `auto:${OWNER}`, {
      derivedFromTurnIds: [turnId],
    });
    assert.equal(turnProps(kg, turnId)[PROMOTION_RETIRED_PROP], undefined);
    await kg.deleteMemory(mk, { actorOmadiaUserId: OWNER });
    const retired = turnProps(kg, turnId)[PROMOTION_RETIRED_PROP] as { reason: string };
    assert.equal(retired.reason, 'memory_deleted');
  });
});

describe('ADR-0190 · pairs close with their entry (#1862)', () => {
  it('deleting one side dismisses its open contradiction and duplicate pairs', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const a = await seedMk(kg, 'Test server Ibis has 8 GB of RAM.', `web:${OWNER}`);
    const b = await seedMk(kg, 'Test server Ibis has 64 GB of RAM.', `web:${OWNER}`);
    const inc = await kg.createInconsistency({ mkAExternalId: a, mkBExternalId: b, summary: 'RAM differs', severity: 'high' });
    const dup = await kg.createMergeCandidate({ mkAExternalId: a, mkBExternalId: b, cosineSim: 0.93 });
    assert.ok(inc && dup);
    await kg.deleteMemory(a, { actorOmadiaUserId: OWNER });
    const incAfter = rawNode(kg, inc.id);
    const dupAfter = rawNode(kg, dup.id);
    assert.equal(incAfter?.props['status'], 'dismissed');
    assert.equal(incAfter?.props['closed_reason'], 'memory_deleted');
    assert.equal(dupAfter?.props['status'], 'dismissed');
    assert.ok(await kg.getMemorableKnowledge(b), 'the other side stays');
  });

  it('refuses a resolution that keeps a deleted side, and deletes nothing', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const a = await seedMk(kg, 'Test server Ibis has 8 GB of RAM.', `web:${OWNER}`);
    const b = await seedMk(kg, 'Test server Ibis has 64 GB of RAM.', `web:${OWNER}`);
    const inc = await kg.createInconsistency({ mkAExternalId: a, mkBExternalId: b, summary: 'RAM differs', severity: 'high' });
    assert.ok(inc);
    // Simulate the pre-fix state: the pair is still open although A is gone.
    const [keepSide, otherSide] = inc.conflictsWith;
    await kg.deleteMemory(keepSide, { actorOmadiaUserId: OWNER });
    const node = rawNode(kg, inc.id);
    assert.ok(node);
    node.props = { ...node.props, status: 'open' };
    await assert.rejects(
      kg.resolveInconsistency(inc.id, 'a_wins', { actorOmadiaUserId: OWNER }),
      (err: unknown) => (err as { code?: string }).code === 'keeper_missing',
    );
    assert.ok(await kg.getMemorableKnowledge(otherSide), 'the last copy survives');
  });
});

function mergeDetector(kg: KnowledgeGraph) {
  return createMergeCandidateDetector({
    graph: kg,
    embeddingClient: embedder,
    autoMergeThreshold: 0.98,
    minSimilarity: 0.9,
    log: () => {},
  });
}

describe('ADR-0190 · safe auto-merge (#1835)', () => {
  it('never deletes a hand-saved correction; the pair stays open', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const older = await seedMk(kg, 'Project Zebra starts on November 10.', `web:${OWNER}`);
    const correction = await seedMk(kg, 'Project Zebra starts on November 13.', `web:${OWNER}`);
    await mergeDetector(kg).detectFor(correction);
    assert.ok(await kg.getMemorableKnowledge(older));
    assert.ok(await kg.getMemorableKnowledge(correction), 'correction kept');
    const open = await kg.listMergeCandidates({ viewerOmadiaUserId: OWNER, status: 'open' });
    assert.equal(open.length, 1);
  });

  it('leaves an auto-saved pair that differs in a number open', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const a = await seedMk(kg, 'Project Zebra starts on November 10.', `auto:${OWNER}`);
    const b = await seedMk(kg, 'Project Zebra starts on November 13.', `auto:${OWNER}`);
    await mergeDetector(kg).detectFor(b);
    assert.ok(await kg.getMemorableKnowledge(a));
    assert.ok(await kg.getMemorableKnowledge(b));
  });

  it('retires the auto-saved copy of a hand-saved entry, audited as the system', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const saved = await seedMk(kg, 'Project Zebra starts on November 10.', `web:${OWNER}`);
    const auto = await seedMk(kg, 'Project Zebra starts on November 10.', `auto:${OWNER}`);
    await mergeDetector(kg).detectFor(saved);
    assert.ok(await kg.getMemorableKnowledge(saved), 'hand-saved kept');
    assert.equal(await kg.getMemorableKnowledge(auto), null, 'auto copy retired');
    const audit = await kg.listMemoryAclAudit(auto);
    const del = audit.find((r) => r.action === 'delete');
    assert.equal(del?.actorOmadiaUserId, SYSTEM_AUDIT_ACTOR_UUID);
    assert.equal(del?.actorChannelIdentityId, 'system:auto-merge');
    assert.match(del?.reason ?? '', /cosine=1\.000/);
    const resolved = await kg.listMergeCandidates({ viewerOmadiaUserId: OWNER, status: 'resolved' });
    assert.equal(resolved[0]?.props.resolved_by, null, 'no person resolved it');
  });
});

describe('ADR-0190 · lost contradiction verdicts are retried (#1861)', () => {
  function graphWith(checked: string[]): KnowledgeGraph {
    const node = (id: string): GraphNode => ({
      id,
      type: 'MemorableKnowledge',
      props: { summary: `Wartung Ibis ${id}`, acl_owners: [OWNER] },
    }) as GraphNode;
    return {
      async getMemorableKnowledge(id: string) {
        return node(id);
      },
      async searchMemorableKnowledgeByEmbedding() {
        return [{ mk: node('mk-b'), cosineSim: 0.9 }];
      },
      async createInconsistency() {
        return null;
      },
      async markMemorableKnowledgeInconsistencyChecked(id: string) {
        checked.push(id);
      },
    } as unknown as KnowledgeGraph;
  }

  function llmReplying(text: string, finishReason = 'end_turn') {
    const calls: Array<{ maxTokens?: number }> = [];
    const llm = {
      async complete(req: { maxTokens?: number }) {
        calls.push(req);
        return { content: [{ type: 'text', text }], finishReason };
      },
    };
    return { calls, llm: llm as never };
  }

  it('a cut-off verdict leaves the entry unchecked', async () => {
    const checked: string[] = [];
    const { llm, calls } = llmReplying('{"compatible": "no", "reason": "Both state the same win', 'max_tokens');
    const detector = createInconsistencyDetector({ graph: graphWith(checked), embeddingClient: embedder, llm, log: () => {} });
    await detector.detectFor('mk-a');
    assert.deepEqual(checked, []);
    assert.equal(calls[0]?.maxTokens, JUDGEMENT_MAX_TOKENS);
    assert.ok(JUDGEMENT_MAX_TOKENS >= 500);
  });

  it('a full set of verdicts marks the entry checked', async () => {
    const checked: string[] = [];
    const { llm } = llmReplying('{"compatible":"yes","reason":"same window","severity":"low"}');
    const detector = createInconsistencyDetector({ graph: graphWith(checked), embeddingClient: embedder, llm, log: () => {} });
    await detector.detectFor('mk-a');
    assert.deepEqual(checked, ['mk-a']);
  });
});

describe('ADR-0190 · only people own memorable knowledge (#1864)', () => {
  it('skips a Public API turn (key:<id>) without touching the database', async () => {
    let queried = false;
    const pool = { async query() { queried = true; return { rows: [] }; } };
    const result = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'default',
      kg: {} as KnowledgeGraph,
      turnId: 'turn:api:2026-11-10T09:00:00.000Z',
      userId: 'key:0d8f0b0e-1111-4111-8111-111111111111',
      threshold: 0.7,
      fallbackAssistantAnswer: 'x',
      log: () => {},
    });
    assert.equal(result.reason, 'no-person-owner');
    assert.equal(queried, false);
  });

  it('skips a retired turn', async () => {
    const pool = {
      async query() {
        return { rows: [{ significance: 0.9, tail_only: false, retired: true }] };
      },
    };
    const result = await promoteTurnIfSignificant({
      pool: pool as never,
      tenantId: 'default',
      kg: {} as KnowledgeGraph,
      turnId: 'turn:x:2026-11-10T09:00:00.000Z',
      userId: OWNER,
      threshold: 0.7,
      fallbackAssistantAnswer: 'x',
      log: () => {},
    });
    assert.equal(result.reason, 'retired');
  });

  it('reads the producing Agent from a qualified turn scope', () => {
    assert.equal(agentOfTurnScope('palaia::web-1'), 'palaia');
    assert.equal(agentOfTurnScope('legacy-scope'), undefined);
    assert.equal(agentOfTurnScope(null), undefined);
  });
});
