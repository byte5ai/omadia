/**
 * OpenAI Responses (SSE) wire-format adapter registration (#294, experimental).
 *
 * Wraps `createOpenAiResponsesProvider` in the neutral `LlmAdapter` contract so
 * the resolution seam in `@omadia/llm-provider` can build the ChatGPT/Codex-
 * backend provider from a descriptor + an OAuth `bearerProvider` without any
 * vendor SDK.
 */
import type {
  LlmAdapter,
  LlmAdapterBuildOptions,
  LlmAdapterRegistry,
  LlmProvider,
} from '@omadia/llm-provider-api';

import { createOpenAiResponsesProvider } from './responsesProvider.js';

export const openAiResponsesAdapter: LlmAdapter = {
  wireFormat: 'openai-responses',
  build(opts: LlmAdapterBuildOptions): LlmProvider {
    if (opts.baseURL === undefined) {
      throw new Error('openai-responses adapter requires a baseURL');
    }
    return createOpenAiResponsesProvider({
      baseURL: opts.baseURL,
      ...(opts.bearerProvider !== undefined
        ? { bearerProvider: opts.bearerProvider }
        : {}),
      ...(opts.apiKey.length > 0 ? { apiKey: opts.apiKey } : {}),
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
    });
  },
};

/** Register the Responses adapter into a registry (call once at boot). */
export function registerOpenAiResponsesAdapter(
  registry: LlmAdapterRegistry,
): void {
  registry.register(openAiResponsesAdapter);
}
