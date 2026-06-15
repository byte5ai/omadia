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
import type { LlmProviderCatalog } from './providerCatalog.js';
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
  /** Base URL for OpenAI-compatible servers (Mistral/Ollama/vLLM/Azure).
   *  Overrides a catalog descriptor's `baseURL` when both are present. */
  readonly baseURL?: string;
  /** SDK auto-retry count (the orchestrator uses 5; others keep the SDK default). */
  readonly maxRetries?: number;
  /** Plugin-contributed provider catalog. When `providerId` is found here, its
   *  `baseURL` + quirks drive the OpenAI-compatible adapter — this is how a
   *  declarative provider plugin (e.g. MiniMax) becomes resolvable. */
  readonly catalog?: LlmProviderCatalog;
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
  // Resolve the catalog descriptor first — it tells us whether this provider
  // even needs a key. A plugin-contributed provider (the catalog) declares its
  // wireFormat; the built-in `anthropic` default keeps the Anthropic wire format
  // with no descriptor.
  const descriptor = opts.catalog?.get(opts.providerId);

  const apiKey = await readProviderApiKey(opts.getSecret, opts.providerId);
  // Local / self-hosted providers (e.g. Ollama) declare `policy.requiresApiKey:
  // false` and run without credentials — build them with an empty key. For every
  // other provider, a missing key means "not connected" → no provider.
  const keyless = descriptor?.policy?.requiresApiKey === false;
  if (apiKey === undefined && !keyless) return undefined;
  // The OpenAI/Anthropic SDK constructors reject a falsy apiKey, so a keyless
  // provider (no credential by design — Ollama ignores the Authorization header)
  // gets a non-empty placeholder instead of ''. Only reached when apiKey is
  // genuinely absent AND the provider declared requiresApiKey:false.
  const resolvedKey = apiKey ?? 'no-key-required';

  // Resolve the wire format + baseURL once. baseURL precedence: explicit
  // opts.baseURL (self-hosted gateway / Azure) > catalog descriptor > a well-known
  // default (knownProviderBaseUrl, e.g. mistral) so the operator never types it.
  const wireFormat =
    descriptor?.wireFormat ??
    (opts.providerId === 'anthropic' ? 'anthropic' : 'openai-compatible');
  const baseURL =
    opts.baseURL ?? descriptor?.baseURL ?? knownProviderBaseUrl(opts.providerId);

  if (wireFormat === 'anthropic') {
    // Anthropic Messages wire format (Claude, or an Anthropic-compatible
    // gateway). No baseURL → SDK default (zero-behavior-change for the built-in
    // anthropic default). Quirks are openai-only and do not apply here.
    return createAnthropicProvider({
      client: createAnthropicClient({
        apiKey: resolvedKey,
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(baseURL !== undefined ? { baseURL } : {}),
      }),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
    });
  }

  // openai, openai-compatible, and any custom compatible id all speak the
  // OpenAI Chat Completions wire format via the same adapter. A plugin descriptor
  // also carries the OpenAI-adapter quirks.
  const quirks = descriptor?.quirks;

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
    apiKey: resolvedKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.providerId !== 'openai' ? { id: opts.providerId } : {}),
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
}
