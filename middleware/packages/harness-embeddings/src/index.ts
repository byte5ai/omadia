/**
 * @omadia/embeddings — public barrel.
 *
 * Sub-Commit 2a (S+9.1): the EmbeddingClient interface, factory,
 * `withConcurrencyLimit`, `cosineSimilarity`, and `EmbeddingError` now
 * live in this package. Kernel code and other plugins (KG, future
 * orchestrator-extras) import from here instead of the old
 * `src/services/embeddingClient.js` path.
 *
 * Sub-Commit 2b flipped the lifetime: `activate()` constructs the client
 * (Ollama wrapper + concurrency limiter) and publishes it via
 * `ctx.services.provide('embeddingClient', client)`.
 *
 * #440: this package is now the *Ollama adapter*, not the contract owner.
 * `EmbeddingClient`, `EmbeddingProvider` and `EmbeddingError` live in
 * `@omadia/plugin-api`; they are re-exported here so out-of-repo plugins
 * that import them from the built `dist/` keep compiling.
 */

export { activate } from './plugin.js';
export type { EmbeddingsPluginHandle } from './plugin.js';

export type {
  EmbeddingClient,
  EmbeddingProvider,
  EmbeddingProviderMetadata,
} from '@omadia/plugin-api';
export { EmbeddingError, withConcurrencyLimit } from '@omadia/plugin-api';

export type {
  EmbeddingClientOptions,
  OllamaDimensionsResolution,
} from './embeddingClient.js';
export {
  DEFAULT_OLLAMA_EMBEDDING_DIMENSIONS,
  OLLAMA_MODEL_ID_PREFIX,
  cosineSimilarity,
  createEmbeddingClient,
  resolveOllamaDimensions,
} from './embeddingClient.js';
