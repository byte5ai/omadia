import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/embeddings';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { createMergeCandidateDetector } from '@omadia/orchestrator-extras';

// Slice 13 · automatic dedup. The merge detector, when given an
// autoMergeThreshold, RESOLVES high-confidence duplicate MK pairs itself
// (retires the duplicate) instead of only flagging. Safety: a durable
// (manuallyAuthored) node is never deleted; both-durable is left alone; else
// the older node wins.

const VEC: number[] = [1, 0, 0, 0]; // every seeded MK shares it ⇒ cosine ≈ 1

const embedder: EmbeddingClient = {
  async embed(): Promise<number[]> {
    return [...VEC];
  },
};

async function seedMk(
  kg: InMemoryKnowledgeGraph,
  summary: string,
  durable: boolean,
): Promise<string> {
  const created = await kg.createMemorableKnowledge({
    kind: 'reference',
    summary,
    createdBy: 'web:bob',
    involvedOmadiaUserIds: [],
    aclOwners: ['bob'],
    ...(durable ? { manuallyAuthored: true } : {}),
  });
  kg.setEmbedding(created.memorableKnowledgeNodeId, VEC);
  return created.memorableKnowledgeNodeId;
}

function detector(kg: InMemoryKnowledgeGraph) {
  return createMergeCandidateDetector({
    graph: kg,
    embeddingClient: embedder,
    autoMergeThreshold: 0.9,
    minSimilarity: 0.9,
    log: () => {},
  });
}

describe('Slice 13 · automatic high-confidence merge', () => {
  it('retires a fuzzy duplicate, keeps the durable one', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const durableId = await seedMk(kg, '# Schema: courses in ud_tutorial', true);
    const fuzzyId = await seedMk(kg, '# Schema: courses in ud_tutorial', false);
    // Source = the freshly-learned fuzzy MK; candidate = the durable one.
    await detector(kg).detectFor(fuzzyId);
    assert.equal(
      await kg.getMemorableKnowledge(fuzzyId),
      null,
      'fuzzy duplicate retired',
    );
    assert.ok(
      await kg.getMemorableKnowledge(durableId),
      'durable node survives (never deleted)',
    );
  });

  it('never deletes a durable node even when it is the source', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const fuzzyId = await seedMk(kg, '# Schema: courses in ud_tutorial', false);
    const durableId = await seedMk(kg, '# Schema: courses in ud_tutorial', true);
    await detector(kg).detectFor(durableId); // source is durable
    assert.ok(
      await kg.getMemorableKnowledge(durableId),
      'durable source survives',
    );
    assert.equal(
      await kg.getMemorableKnowledge(fuzzyId),
      null,
      'fuzzy duplicate retired',
    );
  });

  it('keeps both when BOTH are durable (left for an operator)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const a = await seedMk(kg, '# Schema: courses in ud_tutorial', true);
    const b = await seedMk(kg, '# Schema: courses in ud_tutorial', true);
    await detector(kg).detectFor(b);
    assert.ok(await kg.getMemorableKnowledge(a), 'durable A survives');
    assert.ok(await kg.getMemorableKnowledge(b), 'durable B survives');
  });

  it('two fuzzy duplicates: the OLDER survives', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const older = await seedMk(kg, '# Schema: courses in ud_tutorial', false);
    const newer = await seedMk(kg, '# Schema: courses in ud_tutorial', false);
    await detector(kg).detectFor(newer);
    assert.ok(await kg.getMemorableKnowledge(older), 'older survives');
    assert.equal(
      await kg.getMemorableKnowledge(newer),
      null,
      'newer duplicate retired',
    );
  });

  it('without autoMergeThreshold it only FLAGS (legacy, no deletion)', async () => {
    const kg = new InMemoryKnowledgeGraph();
    const a = await seedMk(kg, '# Schema: courses in ud_tutorial', false);
    const b = await seedMk(kg, '# Schema: courses in ud_tutorial', false);
    const flagOnly = createMergeCandidateDetector({
      graph: kg,
      embeddingClient: embedder,
      log: () => {},
    });
    await flagOnly.detectFor(b);
    assert.ok(await kg.getMemorableKnowledge(a), 'a kept (flag-only)');
    assert.ok(await kg.getMemorableKnowledge(b), 'b kept (flag-only)');
  });
});
