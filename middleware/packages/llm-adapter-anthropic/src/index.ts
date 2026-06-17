/**
 * `@omadia/llm-adapter-anthropic` — the Anthropic Messages wire-format adapter.
 *
 * Confines all `@anthropic-ai/sdk` knowledge to this package. The app registers
 * it into the LLM adapter registry at boot (`registerAnthropicAdapter`); the
 * builder/preview paths that construct a provider from a shared client import
 * `createAnthropicClient` / `createAnthropicProvider` directly from here.
 */
export { anthropicAdapter, registerAnthropicAdapter } from './adapter.js';

export {
  createAnthropicProvider,
  classifyAnthropicError,
  type AnthropicProviderOptions,
} from './anthropicProvider.js';

export {
  createAnthropicClient,
  type AnthropicClient,
  type AnthropicClientOptions,
} from './anthropicClient.js';
