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

export function createAnthropicClient(opts: AnthropicClientOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
  });
}
