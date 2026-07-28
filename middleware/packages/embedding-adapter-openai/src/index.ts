/**
 * @omadia/embedding-adapter-openai — public barrel.
 *
 * Second `embeddingClient@1` adapter (#440), for servers speaking the OpenAI
 * `/v1/embeddings` wire format. The contract lives in `@omadia/plugin-api`;
 * this package only ships the transport plus its plugin lifecycle.
 */

export { activate } from './plugin.js';
export type { OpenAiEmbeddingsPluginHandle } from './plugin.js';

export type { OpenAiEmbeddingClientOptions } from './openaiEmbeddingClient.js';
export {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  OPENAI_MODEL_ID_PREFIX,
  createOpenAiEmbeddingClient,
  defaultDimensionsForModel,
} from './openaiEmbeddingClient.js';
