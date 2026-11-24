/**
 * Anthropic raw-client construction — the ONE place outside the adapter
 * that touches the `@anthropic-ai/sdk` value import.
 *
 * Why this exists: phase 2 of docs/plans/llm-provider-interface-plan.md adds
 * an ESLint `no-restricted-imports` rule banning `@anthropic-ai/sdk` outside
 * this package. Two consumer needs survive that ban:
 *  - the kernel still publishes a raw `anthropicClient` ServiceRegistry entry
 *    that the Teams channel (private plugin repo) and the builder per-turn
 *    re-resolution consume — they need a real `Anthropic` instance and its type;
 *  - plugins construct their own per-vault client.
 * Both go through this factory + the re-exported `AnthropicClient` type so no
 * consumer file imports the SDK directly.
 */
import Anthropic from '@anthropic-ai/sdk';

/** The raw Anthropic SDK client type, re-exported so consumers can type a
 *  shared client without importing `@anthropic-ai/sdk` (keeps the
 *  no-restricted-imports rule clean). */
export type AnthropicClient = Anthropic;

export interface AnthropicClientOptions {
  /** May be empty on cold boots before /setup — the SDK constructor tolerates
   *  it; the first real call fails with an auth error (classified non-retryable). */
  readonly apiKey: string;
  /** SDK auto-retry count for 408/409/429/500/529. Omit to keep the SDK default (2). */
  readonly maxRetries?: number;
  /** Override the API base URL (e.g. an Anthropic-compatible gateway, or the
   *  baseURL a provider plugin declares). Omit to use the SDK default. */
  readonly baseURL?: string;
}

/** The host the SDK's default `Authorization: Bearer` scheme is known to work
 *  against. Every other host is a gateway/proxy we cannot inspect. */
const FIRST_PARTY_API_HOST = 'api.anthropic.com';

/**
 * Whether requests to `baseURL` keep the legacy `X-Api-Key` header.
 *
 * SDK 1.x (API version 2026-10-21) sends the API key as
 * `Authorization: Bearer <key>` instead of `X-Api-Key`. The Claude API accepts
 * both, but an Anthropic-compatible gateway behind a custom base URL (the
 * `anthropic_base_url` provider config, `ANTHROPIC_BASE_URL`, LiteLLM-style
 * proxies) may read only `X-Api-Key`. SDK 0.x sent `X-Api-Key` to every host,
 * so keeping it for non-first-party hosts preserves the pre-upgrade wire
 * behaviour there. An unparseable URL counts as custom (the conservative side).
 */
export function usesLegacyApiKeyHeader(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname !== FIRST_PARTY_API_HOST;
  } catch {
    return true;
  }
}

export function createAnthropicClient(opts: AnthropicClientOptions): Anthropic {
  const base = {
    apiKey: opts.apiKey,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
  };
  const client = new Anthropic(base);
  // `client.baseURL` is the SDK's resolved value (explicit option, else
  // `ANTHROPIC_BASE_URL`, else the first-party default), so an env-configured
  // gateway is covered without reading the environment here.
  if (opts.apiKey.length === 0 || !usesLegacyApiKeyHeader(client.baseURL)) {
    return client;
  }
  // `Authorization: null` stops the SDK from also sending the key as a bearer
  // token, so the gateway sees exactly the header SDK 0.x sent.
  return new Anthropic({
    ...base,
    defaultHeaders: { 'X-Api-Key': opts.apiKey, Authorization: null },
  });
}
