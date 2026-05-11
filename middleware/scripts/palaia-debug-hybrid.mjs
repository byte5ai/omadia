// Calls the production code path so the debug reflects the actual SQL,
// including the NaN-guard fix.
import { createNeonPool, NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon';

const url = process.env.DATABASE_URL;
const pool = createNeonPool(url, 2);
const kg = new NeonKnowledgeGraph({ pool, tenantId: 'byte5' });

// Use a non-zero query vector to keep the cosine leg meaningful.
// (Real callers always pass embed-client output, never zero-norm vectors.)
const vec = new Array(768).fill(0);
vec[0] = 1; // norm = 1 → cosine well-defined

const hits = await kg.searchTurnsByEmbedding({
  queryEmbedding: vec,
  ftsQuery: 'kemia',
  limit: 5,
  recallRecencyBoost: 0,
});

console.log('hits.length =', hits.length);
for (const h of hits) {
  console.log(JSON.stringify({ id: h.turnId.slice(0, 60), rank: Number(h.rank.toFixed(4)) }));
}
await pool.end();
