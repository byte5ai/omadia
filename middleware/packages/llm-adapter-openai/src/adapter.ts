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
  DiscoveredModel,
  LlmAdapter,
  LlmAdapterBuildOptions,
  LlmAdapterRegistry,
  LlmProvider,
} from '@omadia/llm-provider-api';

import { listOpenAiCompatibleModels } from './modelDiscovery.js';
import { createOpenAiClient } from './openaiClient.js';
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
  /** Live catalog via the OpenAI-compatible `GET /v1/models`. OAuth-connected
   *  providers resolve one bearer for the call; nothing is cached here. */
  async listModels(opts: LlmAdapterBuildOptions): Promise<ReadonlyArray<DiscoveredModel>> {
    const apiKey =
      opts.bearerProvider !== undefined ? await opts.bearerProvider() : opts.apiKey;
    const client = createOpenAiClient({
      apiKey,
      maxRetries: 1,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    });
    return listOpenAiCompatibleModels(client);
  },
};

/** Register the OpenAI-compatible adapter into a registry (call once at boot). */
export function registerOpenAiAdapter(registry: LlmAdapterRegistry): void {
  registry.register(openAiAdapter);
}
