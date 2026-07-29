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

// #440 — model/dimension gate. Compares the active embedding provider
// against the model the stored vectors were produced with and blocks vector
// writes on an unrecoverable mismatch.
export {
  allowsVectorWrites,
  clearStaleVectors,
  discoverGovernedVectorColumns,
  evaluateEmbeddingModelGate,
  isStaleVectorClearPending,
  requiresStaleVectorClearResume,
} from './embeddingModelGate.js';
export type {
  ClearOptions,
  EmbeddingModelGateOptions,
  EmbeddingModelGateOutcome,
  GovernedVectorColumn,
  StaleVectorClearResult,
} from './embeddingModelGate.js';

// #440 — read-only catalog probe over a governed vector column. Exported so
// the kernel's embedding-provider admin router can price a provider switch
// ("how many vectors would this discard?") with the SAME query the migration
// already uses for its operator warning, instead of hand-rolling a second one
// that could drift from the column set the gate actually governs.
export { countVectors } from './vectorColumnCatalog.js';
export type { ColumnCatalogInfo } from './vectorColumnCatalog.js';

// #440 — the runtime vector-column width migration the gate performs when the
// declared column width disagrees with the active provider. Exported because
// `EmbeddingModelGateOutcome`'s `column-migrated` arm carries these types.
export { migrateVectorColumns } from './vectorColumnMigration.js';
export type {
  MigratedVectorColumn,
  VectorColumnMigrationOptions,
  VectorColumnMigrationResult,
  VectorColumnTarget,
} from './vectorColumnMigration.js';

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
  CHANNEL_KINDS,
  MEMORABLE_KINDS,
  EXCERPT_SOURCES,
  INCONSISTENCY_STATUSES,
  INCONSISTENCY_RESOLUTIONS,
  INCONSISTENCY_SEVERITIES,
  MERGE_CANDIDATE_STATUSES,
  MERGE_CANDIDATE_RESOLUTIONS,
  EXCERPT_MERGE_STATUSES,
  EXCERPT_MERGE_RESOLUTIONS,
  TOPIC_NAMING_SOURCES,
  GraphNodeTypeSchema,
  GraphEdgeTypeSchema,
  validateNodeProps,
} from './schema.js';
export type {
  ChannelKind,
  GraphEdgeTypeName,
  GraphNodeTypeName,
  MemorableKind,
} from './schema.js';
