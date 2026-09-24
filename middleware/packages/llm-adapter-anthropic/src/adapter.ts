/**
 * Anthropic wire-format adapter registration.
 *
 * Wraps `createAnthropicProvider` (+ its SDK client) in the neutral `LlmAdapter`
 * contract so the resolution seam in `@omadia/llm-provider` can build an
 * Anthropic provider from resolved credentials without importing the SDK. Quirks
 * are OpenAI-only and ignored here.
 */
import type {
  DiscoveredModel,
  LlmAdapter,
  LlmAdapterBuildOptions,
  LlmAdapterRegistry,
  LlmProvider,
} from '@omadia/llm-provider-api';

import { createAnthropicClient } from './anthropicClient.js';
import { createAnthropicProvider } from './anthropicProvider.js';
import { listAnthropicModels } from './modelDiscovery.js';

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
  /** Live catalog via Anthropic's `GET /v1/models` (id, display name, caps,
   *  context/output limits, effort ladder, created_at). */
  async listModels(opts: LlmAdapterBuildOptions): Promise<ReadonlyArray<DiscoveredModel>> {
    const client = createAnthropicClient({
      apiKey: opts.apiKey,
      maxRetries: 1,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    });
    const models = await listAnthropicModels(client);
    return models.map((m) => ({
      modelId: m.modelId,
      label: m.label,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      vision: m.vision,
      effortLevels: m.effortLevels,
      ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
    }));
  },
};

/** Register the Anthropic adapter into a registry (call once at boot). */
export function registerAnthropicAdapter(registry: LlmAdapterRegistry): void {
  registry.register(anthropicAdapter);
}
