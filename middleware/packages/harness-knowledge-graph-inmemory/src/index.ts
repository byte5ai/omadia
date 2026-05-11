// Plugin entry point — kernel-loader picks this up via the manifest.yaml that
// lands in S+11-2b. Until then `activate` is a no-op (S+11-1 scaffold).
export { activate } from './plugin.js';
export type { InMemoryKnowledgeGraphPluginHandle } from './plugin.js';

// Concrete in-memory backend. Constructed by the old @omadia/knowledge-graph
// plugin's activate() in S+11-2a until S+11-2b flips capability-ownership and
// the local activate() takes over.
export { InMemoryKnowledgeGraph } from './inMemoryKnowledgeGraph.js';
