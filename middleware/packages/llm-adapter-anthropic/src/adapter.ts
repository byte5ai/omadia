/**
 * Anthropic wire-format adapter registration.
 *
 * Wraps `createAnthropicProvider` (+ its SDK client) in the neutral `LlmAdapter`
 * contract so the resolution seam in `@omadia/llm-provider` can build an
 * Anthropic provider from resolved credentials without importing the SDK. Quirks
 * are OpenAI-only and ignored here.
 */
import type {
  LlmAdapter,
  LlmAdapterBuildOptions,
  LlmAdapterRegistry,
  LlmProvider,
} from '@omadia/llm-provider-api';

import { createAnthropicClient } from './anthropicClient.js';
import { createAnthropicProvider } from './anthropicProvider.js';

export const anthropicAdapter: LlmAdapter = {
  wireFormat: 'anthropic',
  build(opts: LlmAdapterBuildOptions): LlmProvider {
    return createAnthropicProvider({
      client: createAnthropicClient({
        apiKey: opts.apiKey,
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      }),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
    });
  },
};

/** Register the Anthropic adapter into a registry (call once at boot). */
export function registerAnthropicAdapter(registry: LlmAdapterRegistry): void {
  registry.register(anthropicAdapter);
}
