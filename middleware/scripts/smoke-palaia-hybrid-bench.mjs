// OB-72 boot-smoke benchmark.
//
// Compares pre-OB-72 behaviour (pure-cosine, no ftsQuery) vs the new
// hybrid path (BM25 + cosine + recency + type-weight) on 5 representative
// queries against the live Neon dev DB. The query embedding is derived
// from an existing Turn so the cosine leg has something to score against
// — the dev environment has `embeddings=off`, so brand-new turns get
// `embedding=NULL` and only the FTS leg matters for them.
//
// Outputs a Markdown report suitable for pasting into the OB-72 Notion
// session-note (per HANDOFF DoD §"Benchmark-Note").
//
// Usage:
//   DATABASE_URL=... node scripts/smoke-palaia-hybrid-bench.mjs

import {
  createNeonPool,
  NeonKnowledgeGraph,
} from '@omadia/knowledge-graph-neon';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}
const tenantId = process.env.GRAPH_TENANT_ID ?? 'byte5';

const pool = createNeonPool(url, 2);
const kg = new NeonKnowledgeGraph({ pool, tenantId });

// Pick a Turn embedding to use as the query vector — the cosine leg
// needs a real vector to score against. Pick the most recent Turn that
// has an embedding (boot-smoke artefact: embeddings backfilled offline).
const seed = await pool.query(
  `SELECT external_id, embedding::text AS vec, properties->>'userMessage' AS msg
   FROM graph_nodes
   WHERE tenant_id = $1 AND type = 'Turn' AND embedding IS NOT NULL
   ORDER BY created_at DESC
   LIMIT 1`,
  [tenantId],
);
if (seed.rows.length === 0) {
  console.error('no Turn with embedding in this tenant — skipping benchmark');
  await pool.end();
  process.exit(0);
}
const queryEmbedding = JSON.parse(seed.rows[0].vec);
const seedMsg = seed.rows[0].msg ?? '';
console.log(`# OB-72 Hybrid-Retrieval Benchmark\n`);
console.log(`Query vector seeded from most recent embedded Turn:`);
console.log(`> ${String(seedMsg).slice(0, 200)}\n`);

const queries = [
  { name: 'keyword: HRB number', fts: 'HRB' },
  { name: 'keyword: kemia (corpus token)', fts: 'kemia' },
  { name: 'keyword: bedeutung markenname', fts: 'bedeutung markenname' },
  { name: 'semantic: shorter follow-up', fts: 'erklär nochmal' },
  { name: 'semantic: weak overlap', fts: 'projekt review' },
];

const fmtRow = (h, idx) =>
  `${idx + 1}. \`${h.turnId.slice(0, 60)}…\` rank=${h.rank.toFixed(4)} — ${(h.userMessage || '').slice(0, 80).replace(/\n/g, ' ')}`;

for (const q of queries) {
  console.log(`## ${q.name} — FTS=\`${q.fts}\``);

  const cosineHits = await kg.searchTurnsByEmbedding({
    queryEmbedding,
    limit: 3,
  });
  const hybridHits = await kg.searchTurnsByEmbedding({
    queryEmbedding,
    ftsQuery: q.fts,
    limit: 3,
    recallRecencyBoost: 0.05,
  });

  console.log(`\n**Pure-Cosine top-3:**`);
  if (cosineHits.length === 0) console.log(`(no hits)`);
  else cosineHits.forEach((h, i) => console.log(fmtRow(h, i)));

  console.log(`\n**Hybrid top-3:**`);
  if (hybridHits.length === 0) console.log(`(no hits)`);
  else hybridHits.forEach((h, i) => console.log(fmtRow(h, i)));

  const cosineIds = new Set(cosineHits.map((h) => h.turnId));
  const newInHybrid = hybridHits.filter((h) => !cosineIds.has(h.turnId));
  console.log(
    `\n**Diff:** ${String(newInHybrid.length)} new hits surfaced by hybrid path that pure-cosine missed.\n`,
  );
}

await pool.end();
console.log('— end —');
