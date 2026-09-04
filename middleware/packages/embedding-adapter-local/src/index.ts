/**
 * @omadia/embedding-adapter-local — public barrel.
 *
 * Third `embeddingClient@1` adapter, and the only keyless one (OM-84 /
 * byte5ai/omadia#1003). The contract lives in `@omadia/plugin-api`; this
 * package ships the in-process onnxruntime transport plus its plugin
 * lifecycle.
 */

export { activate } from './plugin.js';
export type {
  LocalEmbeddingsActivateOverrides,
  LocalEmbeddingsPluginHandle,
} from './plugin.js';

export type {
  FeatureExtractor,
  LocalEmbeddingClientOptions,
  PipelineLoader,
} from './localEmbeddingClient.js';
export {
  LOCAL_EMBEDDING_DIMENSIONS,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_MODEL_ID_PREFIX,
  RECOMMENDED_DEDUP_THRESHOLD,
  REQUIRED_MODEL_FILES,
  createLocalEmbeddingClient,
  missingModelFiles,
  modelPath,
} from './localEmbeddingClient.js';
