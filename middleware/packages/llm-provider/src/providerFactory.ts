/**
 * Provider factory: build the right `LlmProvider` for a configured provider id
 * from a vault scope's credentials. This is the seam that lets a plugin/kernel
 * pick a provider by CONFIGURATION instead of hard-coding an adapter.
 *
 * Resolution is now a pure REGISTRY LOOKUP (issue #298): the factory resolves the
 * provider's wire format (from a catalog descriptor, or the `anthropic` default)
 * and the matching adapter from an `LlmAdapterRegistry`, then calls
 * `adapter.build(...)`. The concrete adapters (and their SDKs) live in
 * `@omadia/llm-adapter-*` packages and are registered into the default registry
 * at boot — so THIS package imports no vendor SDK and contains no provider switch.
 *
 * It returns the RAW provider; callers keep their own concerns on top (e.g.
 * `withProviderUsageTracking`, or the orchestrator recording usage itself). It
 * returns `undefined` when no API key is configured for the provider, so the
 * caller skips publishing its capability exactly as the Anthropic-only path did.
 *
 * Zero-behavior-change for the Anthropic default: `providerId: 'anthropic'` with
 * the same key + maxRetries produces the identical provider as before, provided
 * the Anthropic adapter has been registered (the app does this at boot).
 */
import type {
  LlmAdapterRegistry,
  LlmProvider,
} from '@omadia/llm-provider-api';

import { defaultLlmAdapters } from './adapterRegistry.js';
import type { ProviderId } from './modelRegistry.js';
import type { LlmProviderCatalog } from './providerCatalog.js';
import { readProviderApiKey } from './providerCredentials.js';

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
   *  `wireFormat` + `baseURL` + quirks drive resolution — this is how a
   *  declarative provider plugin (e.g. MiniMax) becomes resolvable. */
  readonly catalog?: LlmProviderCatalog;
  /** Wire-format adapter registry. Defaults to the process-wide
   *  `defaultLlmAdapters` (the app registers its bundled adapters into it at
   *  boot); tests pass an isolated registry. */
  readonly adapters?: LlmAdapterRegistry;
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
  // Resolve the catalog descriptor first — it tells us whether this provider even
  // needs a key, and which wire format to resolve. A plugin-contributed provider
  // declares its wireFormat; the built-in `anthropic` default keeps the Anthropic
  // wire format with no descriptor.
  const descriptor = opts.catalog?.get(opts.providerId);

  const apiKey = await readProviderApiKey(opts.getSecret, opts.providerId);
  // Local / self-hosted providers (e.g. Ollama) declare `policy.requiresApiKey:
  // false` and run without credentials. For every other provider, a missing key
  // means "not connected" → no provider (caller skips publishing its capability).
  const keyless = descriptor?.policy?.requiresApiKey === false;
  if (apiKey === undefined && !keyless) return undefined;
  // The SDK constructors reject a falsy apiKey, so a keyless provider (no
  // credential by design — Ollama ignores the Authorization header) gets a
  // non-empty placeholder instead of ''. Only reached when apiKey is genuinely
  // absent AND the provider declared requiresApiKey:false.
  const resolvedKey = apiKey ?? 'no-key-required';

  // baseURL precedence: explicit opts.baseURL (self-hosted gateway / Azure) >
  // catalog descriptor > a well-known default (knownProviderBaseUrl, e.g. mistral)
  // so the operator never types it.
  const wireFormat =
    descriptor?.wireFormat ??
    (opts.providerId === 'anthropic' ? 'anthropic' : 'openai-compatible');
  const baseURL =
    opts.baseURL ?? descriptor?.baseURL ?? knownProviderBaseUrl(opts.providerId);

  // Guard the footgun: only the literal 'openai' may omit a baseURL (it defaults
  // to api.openai.com). Any other openai-compatible id without a (default or
  // explicit) baseURL would silently send a non-OpenAI key to api.openai.com and
  // fail opaquely at request time — fail loudly at build time instead. (The
  // anthropic wire format defaults its own baseURL inside the SDK, so it is exempt.)
  if (
    wireFormat === 'openai-compatible' &&
    opts.providerId !== 'openai' &&
    baseURL === undefined
  ) {
    throw new Error(
      `LLM provider '${opts.providerId}' requires a baseURL (an OpenAI-compatible endpoint); only 'openai' may omit it.`,
    );
  }

  const registry = opts.adapters ?? defaultLlmAdapters;
  const adapter = registry.get(wireFormat);
  if (adapter === undefined) {
    throw new Error(
      `No LLM adapter registered for wire format '${wireFormat}' (provider '${opts.providerId}'). ` +
        `Register an @omadia/llm-adapter-* package for it at boot (e.g. registerAnthropicAdapter / registerOpenAiAdapter).`,
    );
  }

  // `id` stamps a non-default openai-compatible provider (mistral/minimax/…);
  // 'openai' and the anthropic adapter use their own fixed id. `quirks` apply to
  // the openai-compatible adapter only; other adapters ignore them.
  return adapter.build({
    apiKey: resolvedKey,
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.providerId !== 'openai' ? { id: opts.providerId } : {}),
    ...(descriptor?.quirks !== undefined ? { quirks: descriptor.quirks } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
