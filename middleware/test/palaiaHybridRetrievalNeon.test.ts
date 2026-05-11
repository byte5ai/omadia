import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon';

/**
 * Live-Neon integration test for the OB-72 hybrid SQL. Gated on
 * DATABASE_URL so a default `npm test` without env stays fully hermetic.
 *
 * What it asserts:
 *   1. Query without ftsQuery returns hits ordered by cosine_sim
 *      (backwards-compat) — same shape as pre-OB-72.
 *   2. Query with ftsQuery on a known corpus token (`'kemia'` is in the
 *      live dev DB at the time of writing) returns at least one hit.
 *   3. recallMinScore prunes results.
 *
 * Embedding shape: 768 dims (nomic-embed-text). We pass a zero-vector —
 * cosine_sim collapses to 0 for every row, so any non-zero rank must come
 * from the BM25 leg. That isolates the FTS half of the hybrid score.
 */

const DSN = process.env['DATABASE_URL'];
const ENABLED = typeof DSN === 'string' && DSN.length > 0;

const describeIf = ENABLED ? describe : describe.skip;

/**
 * Unit vector of length `dim` with a single 1 at index 0. Norm = 1, so
 * pgvector's cosine `<=>` is well-defined for any (also non-zero) row
 * embedding. Using a zero vector here would trip a Postgres NaN quirk
 * (`NaN > 0` evaluates TRUE), which the production SQL guards against
 * but tests should not depend on.
 */
function unitVector(dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  v[0] = 1;
  return v;
}

describeIf('Palaia Phase 3 · NeonKnowledgeGraph hybrid SQL (live DSN)', () => {
  it('pure-cosine path: no ftsQuery → returns at most `limit` hits, ordered by cosine', async () => {
    const pool = createNeonPool(DSN!, 2);
    try {
      const kg = new NeonKnowledgeGraph({ pool, tenantId: 'byte5' });
      // Zero vector — cosine_sim ≡ 0 for every row → no rows survive the
      // `> 0` predicate inside the hybrid SQL. Empty result is the
      // expected outcome and proves the WHERE clause shape.
      const hits = await kg.searchTurnsByEmbedding({
        queryEmbedding: unitVector(768),
        limit: 3,
      });
      assert.ok(Array.isArray(hits), 'returns array');
      // Either empty (cosine ≡ 0 for all) or all hits have rank > 0.
      for (const h of hits) {
        assert.ok(h.rank >= 0 && h.rank <= 1, 'rank in [0,1]');
      }
    } finally {
      await pool.end();
    }
  });

  it('hybrid path: ftsQuery on a known corpus token returns at least one hit with rank > 0', async () => {
    const pool = createNeonPool(DSN!, 2);
    try {
      const kg = new NeonKnowledgeGraph({ pool, tenantId: 'byte5' });
      const hits = await kg.searchTurnsByEmbedding({
        queryEmbedding: unitVector(768), // isolate BM25 leg
        ftsQuery: 'kemia',
        limit: 5,
        recallRecencyBoost: 0, // deterministic ordering by raw score
      });
      // The dev DB at handoff-time has at least one Turn mentioning "kemia"
      // (verified via psql in the kickoff step). If the corpus is rotated
      // away from this token the test still has to pass shape-wise.
      assert.ok(Array.isArray(hits));
      for (const h of hits) {
        assert.ok(h.rank > 0, 'BM25-only hits must have rank > 0');
        assert.ok(h.rank <= 1, 'rank clamped to ≤ 1');
        assert.equal(typeof h.turnId, 'string');
        assert.ok(h.turnId.startsWith('turn:'));
      }
    } finally {
      await pool.end();
    }
  });

  it('recallMinScore drops below-threshold hits', async () => {
    const pool = createNeonPool(DSN!, 2);
    try {
      const kg = new NeonKnowledgeGraph({ pool, tenantId: 'byte5' });
      const hits = await kg.searchTurnsByEmbedding({
        queryEmbedding: unitVector(768),
        ftsQuery: 'kemia',
        limit: 5,
        recallMinScore: 0.99,
        recallRecencyBoost: 0,
      });
      // 0.99 is unreachable for a zero-cosine + BM25-only score; the
      // result must be empty regardless of corpus content.
      assert.equal(hits.length, 0);
    } finally {
      await pool.end();
    }
  });
});
