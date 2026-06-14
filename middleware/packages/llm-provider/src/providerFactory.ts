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
import type { FetchLike, NowMs, OAuthClientConfig } from './oauthDeviceFlow.js';
import { createOpenAiProvider } from './openaiProvider.js';
import {
  readProviderApiKey,
  resolveProviderOAuthBearer,
} from './providerCredentials.js';
import type { LlmProvider } from './types.js';

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
  /**
   * Optional "Sign in with ChatGPT" path (4b, experimental). When provided AND
   * the provider has stored OAuth tokens, the resolved (auto-refreshed) access
   * token is used as the bearer INSTEAD of the api_key. Absent OAuth tokens →
   * the api_key path is taken unchanged, so existing installs are unaffected.
   * The token's audience is OpenAI's Codex/ChatGPT backend — set `baseURL`
   * accordingly (see oauthDeviceFlow.ts).
   */
  readonly oauth?: {
    readonly set: (key: string, value: string) => Promise<void>;
    readonly fetchImpl: FetchLike;
    readonly config: OAuthClientConfig;
    readonly nowMs: NowMs;
  };
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
  // OAuth ("Sign in with ChatGPT") takes precedence when configured AND the
  // provider actually has stored tokens; otherwise fall back to the api_key
  // path (byte-identical for installs without OAuth). The resolved value is the
  // bearer either way.
  const oauthBearer =
    opts.oauth !== undefined
      ? await resolveProviderOAuthBearer({
          get: opts.getSecret,
          set: opts.oauth.set,
          providerId: opts.providerId,
          fetchImpl: opts.oauth.fetchImpl,
          config: opts.oauth.config,
          nowMs: opts.oauth.nowMs,
        })
      : undefined;
  const apiKey =
    oauthBearer ?? (await readProviderApiKey(opts.getSecret, opts.providerId));
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
  // Guard the footgun: only the literal 'openai' may omit a baseURL (it defaults
  // to api.openai.com). Any other id without a baseURL would silently send a
  // non-OpenAI key to api.openai.com and fail opaquely at request time — fail
  // loudly at build time instead.
  if (opts.providerId !== 'openai' && opts.baseURL === undefined) {
    throw new Error(
      `LLM provider '${opts.providerId}' requires a baseURL (an OpenAI-compatible endpoint); only 'openai' may omit it.`,
    );
  }
  return createOpenAiProvider({
    apiKey,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.providerId !== 'openai' ? { id: opts.providerId } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
