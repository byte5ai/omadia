/**
 * OpenAI (Chat Completions) wire-format adapter registration.
 *
 * Wraps `createOpenAiProvider` in the neutral `LlmAdapter` contract so the
 * resolution seam in `@omadia/llm-provider` can build an OpenAI-compatible
 * provider from resolved credentials + descriptor quirks without importing the
 * SDK. This one adapter serves the whole OpenAI-compatible family — `id` +
 * `baseURL` + `quirks` (from the descriptor) specialise it per provider.
 */
import type {
  LlmAdapter,
  LlmAdapterBuildOptions,
  LlmAdapterRegistry,
  LlmProvider,
} from '@omadia/llm-provider-api';

import { createOpenAiProvider } from './openaiProvider.js';

export const openAiAdapter: LlmAdapter = {
  wireFormat: 'openai-compatible',
  build(opts: LlmAdapterBuildOptions): LlmProvider {
    const quirks = opts.quirks;
    return createOpenAiProvider({
      apiKey: opts.apiKey,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...(quirks?.maxTokensField !== undefined
        ? { maxTokensField: quirks.maxTokensField }
        : {}),
      ...(quirks?.dropToolChoice !== undefined
        ? { dropToolChoice: quirks.dropToolChoice }
        : {}),
      ...(quirks?.checkBaseResp !== undefined
        ? { checkBaseResp: quirks.checkBaseResp }
        : {}),
      ...(quirks?.extraBody !== undefined ? { extraBody: quirks.extraBody } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
    });
  },
};

/** Register the OpenAI-compatible adapter into a registry (call once at boot). */
export function registerOpenAiAdapter(registry: LlmAdapterRegistry): void {
  registry.register(openAiAdapter);
}
