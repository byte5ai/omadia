/**
 * Provider factory (phase 4): build the right `LlmProvider` for a configured
 * provider id from a vault scope's credentials. This is the seam that lets a
 * plugin/kernel pick Anthropic or OpenAI (or an OpenAI-compatible server) by
 * configuration instead of hard-coding `createAnthropicProvider`.
 *
 * It returns the RAW provider; callers keep their own concerns on top (e.g.
 * `withProviderUsageTracking`, or the orchestrator recording usage itself). It
 * returns `undefined` when no API key is configured for the provider, so the
 * caller skips publishing its capability exactly as the Anthropic-only path
 * did before.
 *
 * Zero-behavior-change for the Anthropic default: `providerId: 'anthropic'`
 * with the same key + maxRetries produces the identical provider the call
 * sites built inline previously.
 */
import { createAnthropicClient } from './anthropicClient.js';
import { createAnthropicProvider } from './anthropicProvider.js';
import type { ProviderId } from './modelRegistry.js';
import { createOpenAiProvider } from './openaiProvider.js';
import { readProviderApiKey } from './providerCredentials.js';
import type { LlmProvider } from './types.js';

/**
 * Default API base URLs for well-known OpenAI-compatible providers, so an
 * operator who selects e.g. `mistral` never has to type the endpoint. The
 * registry deliberately holds no baseURL (resolution metadata only), so this
 * is the single source for "where does provider X's API live". `openai` is
 * intentionally absent — the SDK defaults it to api.openai.com.
 */
const KNOWN_PROVIDER_BASE_URLS: Readonly<Record<string, string>> = {
  mistral: 'https://api.mistral.ai/v1',
};

/** The default API base URL for a well-known compatible provider, or
 *  `undefined` for `openai`/`anthropic`/unknown ids (caller must supply one). */
export function knownProviderBaseUrl(providerId: string): string | undefined {
  return KNOWN_PROVIDER_BASE_URLS[providerId];
}

export interface ResolveLlmProviderOptions {
  /** `anthropic` | `openai` | `openai-compatible` | a custom compatible id. */
  readonly providerId: ProviderId;
  /** Scope-bound vault read — `(k) => ctx.secrets.get(k)` or
   *  `(k) => vault.get(agentId, k)`. */
  readonly getSecret: (key: string) => Promise<string | undefined>;
  /** Base URL for OpenAI-compatible servers (Mistral/Ollama/vLLM/Azure). */
  readonly baseURL?: string;
  /** SDK auto-retry count (the orchestrator uses 5; others keep the SDK default). */
  readonly maxRetries?: number;
  readonly log?: (...args: unknown[]) => void;
}

/**
 * Build the provider for `providerId` from its vault credentials, or
 * `undefined` if no key is configured. `anthropic` reads its key with the
 * legacy fallback; every other provider is canonical-only (see
 * `readProviderApiKey`).
 */
export async function resolveLlmProvider(
  opts: ResolveLlmProviderOptions,
): Promise<LlmProvider | undefined> {
  const apiKey = await readProviderApiKey(opts.getSecret, opts.providerId);
  if (apiKey === undefined) return undefined;

  if (opts.providerId === 'anthropic') {
    return createAnthropicProvider({
      client: createAnthropicClient({
        apiKey,
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      }),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
    });
  }

  // openai, openai-compatible, and any custom compatible id all speak the
  // OpenAI Chat Completions wire format via the same adapter. A non-openai id
  // with a baseURL becomes an openai-compatible provider carrying that id.
  //
  // A well-known compatible provider (e.g. `mistral`) supplies its own default
  // baseURL, so the operator never types the endpoint. An explicit baseURL
  // still wins (self-hosted gateway / Azure deployment).
  const baseURL = opts.baseURL ?? knownProviderBaseUrl(opts.providerId);

  // Guard the footgun: only the literal 'openai' may omit a baseURL (it defaults
  // to api.openai.com). Any other id without a (default or explicit) baseURL
  // would silently send a non-OpenAI key to api.openai.com and fail opaquely at
  // request time — fail loudly at build time instead.
  if (opts.providerId !== 'openai' && baseURL === undefined) {
    throw new Error(
      `LLM provider '${opts.providerId}' requires a baseURL (an OpenAI-compatible endpoint); only 'openai' may omit it.`,
    );
  }
  return createOpenAiProvider({
    apiKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.providerId !== 'openai' ? { id: opts.providerId } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
