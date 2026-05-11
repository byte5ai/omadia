// Plugin entry point — kernel-loader picks this up via the manifest.yaml that
// lands in S+11-2b. Until then `activate` is a no-op (S+11-1 scaffold).
export { activate } from './plugin.js';
export type { NeonKnowledgeGraphPluginHandle } from './plugin.js';

// Concrete Neon-Postgres + pgvector backend, the pool factory, and the
// migration runner. Constructed by the old @omadia/knowledge-graph
// plugin's activate() in S+11-2a until S+11-2b flips capability-ownership
// and the local activate() takes over.
export {
  NeonKnowledgeGraph,
  createNeonPool,
  rowToNode,
} from './neonKnowledgeGraph.js';
export type {
  NeonKnowledgeGraphOptions,
  NodeRow,
} from './neonKnowledgeGraph.js';
export { runGraphMigrations } from './migrator.js';

// Embedding-backfill scheduler. The InMemory sibling has no persistence
// layer to back-fill, so this lives only here.
export { startEmbeddingBackfill } from './embeddingBackfill.js';
export type {
  EmbeddingBackfillHandle,
  EmbeddingBackfillOptions,
  EmbeddingBackfillStats,
} from './embeddingBackfill.js';

// Palaia-Phase-5 (OB-74) — Per-Agent Block/Boost-Store. Backs the
// `agentPriorities@1` capability published by activate(). The InMemory
// sibling falls back to the NoopAgentPrioritiesStore from plugin-api.
export { NeonAgentPrioritiesStore } from './agentPrioritiesStore.js';
export type { NeonAgentPrioritiesStoreOptions } from './agentPrioritiesStore.js';

// Zod-schema helpers for graph-node validation. Re-exported so callers
// outside this package (currently the old plugin) can keep type-validating
// their ingest payloads.
export {
  GRAPH_NODE_TYPES,
  GRAPH_EDGE_TYPES,
  validateNodeProps,
} from './schema.js';
