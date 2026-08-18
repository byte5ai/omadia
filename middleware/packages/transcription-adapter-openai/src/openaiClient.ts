/**
 * OpenAI raw-client construction for the transcription adapter — the ONE place
 * in this package that touches the `openai` value import for client building
 * (mirrors `llm-adapter-openai/src/openaiClient.ts`).
 *
 * Why an own factory instead of reusing `@omadia/llm-adapter-openai`: the two
 * packages are semantically skewed (LLM wire adapter vs. transcription
 * capability adapter), and the realtime follow-up needs this package's own
 * `openai/*` deep imports anyway — a dependency would couple release cadences
 * for one constructor call. The phase-2 ESLint `no-restricted-imports` rule
 * allowlists this package explicitly.
 */
import OpenAI from 'openai';

/** The raw OpenAI SDK client type, re-exported so consumers can type a client
 *  without importing `openai` (keeps no-restricted-imports clean). */
export type OpenAiTranscriptionClient = OpenAI;

export interface OpenAiTranscriptionClientOptions {
  /** Must be non-empty: the OpenAI SDK constructor REJECTS a falsy apiKey. */
  readonly apiKey: string;
  /** Override the API base URL (self-hosted gateways, test servers). Must
   *  include the version prefix, e.g. `https://api.openai.com/v1`. */
  readonly baseURL?: string;
  /** SDK auto-retry count for transient failures. Omit to keep the SDK
   *  default (2). Every retry the SDK sends is a provider attempt the
   *  operator pays for — `TranscriptionUsage.attempts` must count them. */
  readonly maxRetries?: number;
  /** Custom fetch implementation. The SDK exposes no retry hook, so the
   *  service wraps fetch with a per-call counter to meter attempts including
   *  SDK-internal retries; tests inject fakes through the same seam. */
  readonly fetch?: typeof globalThis.fetch;
}

export function createOpenAiTranscriptionClient(
  opts: OpenAiTranscriptionClientOptions,
): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
}
