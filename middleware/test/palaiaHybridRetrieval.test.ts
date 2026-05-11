import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

/**
 * Palaia-Integration Phase 3 (OB-72) — Hybrid-Retrieval.
 *
 * The Neon backend is exercised by the `ts_rank_cd` + `<=>` SQL in
 * `searchTurnsByEmbedding` and verified end-to-end via the boot-smoke
 * benchmark (HANDOFF §"Boot-Smoke-Vorlage"). This unit suite covers what
 * we can hold flat: the in-memory mirror (which gets a minimal hybrid
 * parity for tests) and the backwards-compatibility contract (callers
 * without ftsQuery see pure-cosine behaviour, which for InMemory is
 * still []).
 */

describe('Palaia Phase 3 · InMemoryKnowledgeGraph hybrid parity', () => {
  it('returns [] when ftsQuery is absent (pure-cosine path, no embeddings stored)', async () => {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 'demo',
      time: '2026-05-07T10:00:00Z',
      userMessage: 'wir besprechen Anna Müller',
      assistantAnswer: 'verstanden',
      entityRefs: [],
    });
    const hits = await g.searchTurnsByEmbedding({
      queryEmbedding: [0.1, 0.2, 0.3],
      // no ftsQuery → in-memory backend can't score (no embeddings)
    });
    assert.deepEqual(hits, []);
  });

  it('scores via BM25-leg + recency when ftsQuery is provided', async () => {
    const g = new InMemoryKnowledgeGraph();
    // Older turn matches the query strongly.
    await g.ingestTurn({
      scope: 's1',
      time: '2026-04-01T10:00:00Z',
      userMessage: 'Anna Müller wird neue CTO',
      assistantAnswer: 'notiert',
      entityRefs: [],
    });
    // Newer turn matches less but is fresher.
    await g.ingestTurn({
      scope: 's2',
      time: '2026-05-06T10:00:00Z',
      userMessage: 'Müller hat zugesagt',
      assistantAnswer: 'gut',
      entityRefs: [],
    });

    const hits = await g.searchTurnsByEmbedding({
      queryEmbedding: [0],
      ftsQuery: 'Anna Müller',
      recallRecencyBoost: 0, // disable recency for deterministic ordering
    });
    assert.equal(hits.length, 2, 'both turns should match (Anna or Müller)');
    // Older turn matches both tokens (2/2) → higher BM25 → ranks first
    assert.equal(hits[0]!.userMessage, 'Anna Müller wird neue CTO');
    assert.equal(hits[1]!.userMessage, 'Müller hat zugesagt');
    assert.ok(hits[0]!.rank > hits[1]!.rank);
  });

  it('recency boost lifts the newer turn above the older one when matches are equal', async () => {
    const g = new InMemoryKnowledgeGraph();
    const now = Date.now();
    const isoOld = new Date(now - 365 * 86_400_000).toISOString();
    const isoNew = new Date(now - 1 * 86_400_000).toISOString();
    await g.ingestTurn({
      scope: 'old',
      time: isoOld,
      userMessage: 'Müller besprochen',
      assistantAnswer: 'ok',
      entityRefs: [],
    });
    await g.ingestTurn({
      scope: 'new',
      time: isoNew,
      userMessage: 'Müller besprochen',
      assistantAnswer: 'ok',
      entityRefs: [],
    });
    const hits = await g.searchTurnsByEmbedding({
      queryEmbedding: [0],
      ftsQuery: 'Müller',
      recallRecencyBoost: 0.1, // ~7d half-life → strong preference for recent
    });
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.scope, 'new');
    assert.ok(hits[0]!.rank > hits[1]!.rank);
  });

  it('honours recallMinScore by dropping below-threshold hits', async () => {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 's',
      time: '2026-05-01T10:00:00Z',
      userMessage: 'Müller besprochen',
      assistantAnswer: 'ok',
      entityRefs: [],
    });
    const hits = await g.searchTurnsByEmbedding({
      queryEmbedding: [0],
      ftsQuery: 'Müller',
      recallRecencyBoost: 0,
      recallMinScore: 0.99, // unrealistically high
    });
    assert.equal(hits.length, 0, 'all hits must drop under unreachable threshold');
  });

  it('respects entryTypes hard-filter (Turn defaults to entry_type=memory)', async () => {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 's',
      time: '2026-05-01T10:00:00Z',
      userMessage: 'Müller',
      assistantAnswer: 'ok',
      entityRefs: [],
    });
    const memoryHits = await g.searchTurnsByEmbedding({
      queryEmbedding: [0],
      ftsQuery: 'Müller',
      recallRecencyBoost: 0,
      entryTypes: ['memory'],
    });
    assert.equal(memoryHits.length, 1);
    const taskOnlyHits = await g.searchTurnsByEmbedding({
      queryEmbedding: [0],
      ftsQuery: 'Müller',
      recallRecencyBoost: 0,
      entryTypes: ['task'],
    });
    assert.equal(taskOnlyHits.length, 0);
  });

  it('type-weights re-rank turns of different entry_types', async () => {
    const g = new InMemoryKnowledgeGraph();
    // Two turns with identical match strength but different entry_types.
    // (We have to mutate the in-memory node directly — the public API
    // only sets entry_type='memory' on Turn ingest in Phase 1.)
    await g.ingestTurn({
      scope: 'm',
      time: '2026-05-01T10:00:00Z',
      userMessage: 'Müller besprochen',
      assistantAnswer: 'ok',
      entityRefs: [],
    });
    await g.ingestTurn({
      scope: 'p',
      time: '2026-05-01T10:00:00Z',
      userMessage: 'Müller besprochen',
      assistantAnswer: 'ok',
      entityRefs: [],
    });
    // Reach into the InMemory node store to flip one turn's entry_type
    // — Phase 2 (OB-71) will provide a proper API for this.
    const view = await g.getSession('p');
    if (view?.turns[0]?.turn) {
      (view.turns[0].turn as { entryType?: string }).entryType = 'process';
    }
    const hits = await g.searchTurnsByEmbedding({
      queryEmbedding: [0],
      ftsQuery: 'Müller',
      recallRecencyBoost: 0,
      typeWeights: { memory: 1.0, process: 5.0 },
    });
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.scope, 'p', 'process-turn must rank first under heavy process-weight');
  });

  it('excludeTurnIds drops the current turn from results', async () => {
    const g = new InMemoryKnowledgeGraph();
    await g.ingestTurn({
      scope: 'a',
      time: '2026-05-01T10:00:00Z',
      userMessage: 'Müller',
      assistantAnswer: 'ok',
      entityRefs: [],
    });
    await g.ingestTurn({
      scope: 'b',
      time: '2026-05-01T10:00:00Z',
      userMessage: 'Müller',
      assistantAnswer: 'ok',
      entityRefs: [],
    });
    const hits = await g.searchTurnsByEmbedding({
      queryEmbedding: [0],
      ftsQuery: 'Müller',
      recallRecencyBoost: 0,
      excludeTurnIds: ['turn:a:2026-05-01T10:00:00Z'],
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.scope, 'b');
  });
});
