/**
 * @omadia/embeddings — public barrel.
 *
 * Sub-Commit 2a (S+9.1): the EmbeddingClient interface, factory,
 * `withConcurrencyLimit`, `cosineSimilarity`, and `EmbeddingError` now
 * live in this package. Kernel code and other plugins (KG, future
 * orchestrator-extras) import from here instead of the old
 * `src/services/embeddingClient.js` path.
 *
 * Sub-Commit 2b will flip the lifetime: `activate()` will construct an
 * EmbeddingClient (Ollama wrapper + concurrency limiter) and publish it
 * via `ctx.services.provide('embeddingClient', client)`. The kernel-side
 * Pre-S+8.5 bridge in `src/index.ts` is deleted, the manifest declares
 * `provides: ["embeddingClient@1"]`, and consumer manifests (KG,
 * later orchestrator-extras) get `requires: ["embeddingClient@^1"]`.
 */

export { activate } from './plugin.js';
export type { EmbeddingsPluginHandle } from './plugin.js';

export type {
  EmbeddingClient,
  EmbeddingClientOptions,
} from './embeddingClient.js';
export {
  EmbeddingError,
  cosineSimilarity,
  createEmbeddingClient,
  withConcurrencyLimit,
} from './embeddingClient.js';
