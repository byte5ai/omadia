/**
 * OpenAI raw-client construction — the ONE place outside the adapter that
 * touches the `openai` value import (mirrors `anthropicClient.ts`).
 *
 * Why this exists: the phase-2 ESLint `no-restricted-imports` rule confines the
 * vendor SDKs to `packages/llm-provider`. Consumers (the kernel ServiceRegistry,
 * the provider-admin layer in phase 4) build a client through this factory and
 * the re-exported `OpenAiClient` type, so no consumer file imports `openai`.
 *
 * The same factory covers the OpenAI-compatible servers (Mistral, Ollama, vLLM,
 * Azure OpenAI) via `baseURL` — they all speak the Chat Completions wire format.
 */
import OpenAI from 'openai';

/** The raw OpenAI SDK client type, re-exported so consumers can type a shared
 *  client without importing `openai` (keeps no-restricted-imports clean). */
export type OpenAiClient = OpenAI;

export interface OpenAiClientOptions {
  /** Must be non-empty: the OpenAI SDK constructor REJECTS a falsy apiKey
   *  ("Missing credentials… set OPENAI_API_KEY"). Keyless providers (local
   *  self-hosted, e.g. Ollama) pass a placeholder via resolveLlmProvider; the
   *  server ignores the Authorization header. A wrong key fails at first call
   *  with an auth error (classified non-retryable). */
  readonly apiKey: string;
  /** Override the API base URL for OpenAI-compatible servers (Mistral, Ollama,
   *  vLLM, Azure OpenAI). Omit for api.openai.com. */
  readonly baseURL?: string;
  /** SDK auto-retry count for transient failures. Omit to keep the SDK default (2). */
  readonly maxRetries?: number;
}

export function createOpenAiClient(opts: OpenAiClientOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  });
}
