/**
 * One-shot migration: reads session transcripts from any local memory dir
 * (typically a copy pulled from Fly) and backfills them into the configured
 * knowledge-graph store. Idempotent — rerunning adds nothing new thanks to
 * the node external-id uniqueness.
 *
 * Usage:
 *   npx tsx scripts/backfill-from-memory-dir.ts <path-to-memory-dir>
 * Defaults to ./fly-memory-pull/memory if no path is given.
 */
import 'dotenv/config';
import { FilesystemMemoryStore } from '@omadia/memory';
import { createKnowledgeGraph } from '../src/services/graph/index.js';
import { backfillGraph } from '@omadia/orchestrator-extras';

const memDir = process.argv[2] ?? './fly-memory-pull/memory';
console.log(`[backfill] source memory dir: ${memDir}`);

const store = new FilesystemMemoryStore(memDir);
await store.init();

const { graph, pool } = await createKnowledgeGraph({
  log: (msg) => console.log(msg),
});
if (!pool) {
  console.warn(
    '[backfill] WARN: no DATABASE_URL — running against in-memory graph (no Neon persistence)',
  );
}

const before = await graph.stats();
console.log(`[backfill] before: nodes=${String(before.nodes)} edges=${String(before.edges)}`);

const result = await backfillGraph(store, graph);
console.log(
  `[backfill] scopes=${String(result.scopes)} files=${String(result.files)} turns=${String(result.turns)} skipped=${String(result.skippedFiles.length)}`,
);
if (result.skippedFiles.length > 0) {
  console.log('[backfill] skipped:', result.skippedFiles);
}

const after = await graph.stats();
console.log(`[backfill] after:  nodes=${String(after.nodes)} edges=${String(after.edges)}`);
console.log(
  `[backfill] diff:   nodes=+${String(after.nodes - before.nodes)} edges=+${String(after.edges - before.edges)}`,
);

if (pool) await pool.end();
console.log('[backfill] done');
