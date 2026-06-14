/**
 * Provider-agnostic LLM contract — the neutral DTOs every adapter maps
 * to and from. No type in this file may reference a vendor SDK; the
 * Anthropic/OpenAI/... specifics live exclusively inside the adapters.
 *
 * Naming note: the middleware also has `LlmProvider` in
 * `@omadia/plugin-api` (the narrow ctx.llm plugin surface). That one is
 * a CONSUMER of this contract (see `src/platform/anthropicLlmProvider.ts`),
 * not a duplicate — import-alias it when both appear in one file.
 */

// ---------------------------------------------------------------------------
// Message content parts
// ---------------------------------------------------------------------------

export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

/** Image attachment. `data` is raw base64 (no data-URL prefix); adapters
 *  re-encode into the vendor shape (Anthropic base64 source, OpenAI
 *  data-URL, …). Only valid on `user` messages. */
export interface ImagePart {
  readonly type: 'image';
  /** IANA media type, e.g. `image/png`, `image/jpeg`. */
  readonly mediaType: string;
  /** Base64-encoded image bytes. */
  readonly data: string;
}

/** A tool invocation requested by the model (assistant message). */
export interface ToolCallPart {
  readonly type: 'tool_call';
  /** Provider-issued call id — must be echoed back in the ToolResultPart. */
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** The host's answer to a ToolCallPart (user message). */
export interface ToolResultPart {
  readonly type: 'tool_result';
  /** The `id` of the ToolCallPart this result answers. */
  readonly toolCallId: string;
  /** Adapters whose vendor only accepts string tool results (e.g.
   *  OpenAI's `role:'tool'`) MUST collect the text parts and surface a
   *  clear error on image parts — never drop them silently. */
  readonly content: string | ReadonlyArray<TextPart | ImagePart>;
  readonly isError?: boolean;
}

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart;

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: ReadonlyArray<ContentPart>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input. Adapters validate vendor-specific
   *  restrictions (e.g. OpenAI strict mode) and throw early. */
  readonly inputSchema: Record<string, unknown>;
}

export type ToolChoice =
  | { readonly type: 'auto'; readonly disableParallel?: boolean }
  | { readonly type: 'none' }
  /** Force any tool call. Gate on `capabilities.forcedToolChoice`. */
  | { readonly type: 'required'; readonly disableParallel?: boolean }
  /** Force one specific tool. Gate on `capabilities.forcedToolChoice`. */
  | {
      readonly type: 'tool';
      readonly name: string;
      readonly disableParallel?: boolean;
    };

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

/** Prompt-caching hints. Adapters without the capability ignore them
 *  silently (OpenAI caches automatically, Mistral not at all). */
export interface CacheHints {
  /** Cache the system prompt (Anthropic: `cache_control` on system). */
  readonly system?: boolean;
  /** Cache everything up to and including the tool specs (Anthropic:
   *  `cache_control` on the last tool — stable across loop iterations). */
  readonly tools?: boolean;
}

/** One block of a structured system prompt. The structured form exists so a
 *  caller can place prompt-cache breakpoints PRECISELY: the orchestrator caches
 *  its stable domain prompt + prior-context block but leaves the per-turn date
 *  and retry-hint blocks uncached, so the cache survives across turns. A single
 *  `string` system (with `cacheHints.system`) caches all-or-nothing and cannot
 *  express that. Providers without prompt caching concatenate the `text`s and
 *  ignore `cache`. */
export interface SystemBlock {
  readonly text: string;
  /** Mark an ephemeral prompt-cache breakpoint at this block (Anthropic
   *  `cache_control`). Everything up to and including it is cached. */
  readonly cache?: boolean;
}

export interface LlmRequest {
  /** Bare vendor model id (e.g. `claude-opus-4-8`, `gpt-5.5`). Resolving
   *  registry refs (`anthropic:…`, `class:frontier`) happens BEFORE the
   *  adapter — adapters only see their own vendor's ids. */
  readonly model: string;
  /** Plain string (use `cacheHints.system` to cache it whole) OR structured
   *  blocks that carry their own per-block cache breakpoints (then
   *  `cacheHints.system` is ignored — the blocks are authoritative). */
  readonly system?: string | ReadonlyArray<SystemBlock>;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly tools?: ReadonlyArray<ToolSpec>;
  readonly toolChoice?: ToolChoice;
  readonly cacheHints?: CacheHints;
  /** Provider-specific preview/beta opt-ins. The Anthropic adapter maps these
   *  to the `anthropic-beta` request header (e.g. the orchestrator opts into
   *  `context-management-2025-06-27`); adapters without a beta channel ignore
   *  them. The one sanctioned escape hatch for vendor preview features — keep
   *  it short and provider-neutral at the call site (pass a documented const). */
  readonly betas?: ReadonlyArray<string>;
}

/** Neutral completion-end signal. `stop_sequence` and other vendor
 *  nuances collapse into `stop`; the raw vendor value survives in
 *  `LlmResponse.providerFinishReason` for callers that need it. */
export type FinishReason = 'stop' | 'tool_calls' | 'max_tokens';

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Anthropic `cache_creation_input_tokens`; undefined elsewhere. */
  readonly cacheWriteTokens?: number;
  /** Anthropic `cache_read_input_tokens`; undefined elsewhere. */
  readonly cacheReadTokens?: number;
}

export interface LlmResponse {
  readonly content: ReadonlyArray<ContentPart>;
  readonly finishReason: FinishReason;
  /** Raw vendor stop/finish value (`end_turn`, `stop_sequence`,
   *  `tool_use`, `length`, …) for legacy mappings and diagnostics. */
  readonly providerFinishReason?: string;
  /** The model id the vendor reports having served. */
  readonly model: string;
  readonly usage: LlmUsage;
}

/**
 * One event from a streamed completion. The minimal neutral set a caller
 * needs to drive a live UI + token meter without seeing vendor SSE shapes:
 *
 *  - `text_delta`     — assistant answer text arrived; forward to the UI.
 *  - `tool_use_start` — the model began emitting a tool call (Anthropic
 *                       `content_block_start` of type `tool_use`; OpenAI the
 *                       first `tool_calls` delta). Lets the caller flip a
 *                       "running tool" phase indicator. Carries no payload —
 *                       the resolved call lands in the `final` response.
 *  - `tool_input_delta` — partial tool-argument JSON. NOT answer text, so it
 *                       is never forwarded to the UI, but callers approximating
 *                       a live token count want it. Adapters whose vendor does
 *                       not surface partial tool args simply never emit it.
 *  - `final`          — exactly one terminal event with the full response.
 *
 * `text_delta` + `final` are the original phase-1 pair; `tool_use_start` and
 * `tool_input_delta` were added in phase 2 for the orchestrator streaming path
 * and are OPTIONAL to emit — a caller that ignores them still works.
 */
export type LlmStreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_use_start' }
  | { readonly type: 'tool_input_delta'; readonly text: string }
  | { readonly type: 'final'; readonly response: LlmResponse };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type LlmErrorKind = 'rate_limit' | 'overloaded' | 'auth' | 'other';

export interface LlmErrorClassification {
  readonly retryable: boolean;
  readonly kind: LlmErrorKind;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  readonly tools: boolean;
  readonly vision: boolean;
  readonly streaming: boolean;
  readonly promptCaching: boolean;
  /** Supports `toolChoice: { type: 'required' | 'tool' }`. */
  readonly forcedToolChoice: boolean;
  readonly parallelToolCalls: boolean;
}

export interface LlmProvider {
  /** Stable adapter id: `anthropic`, `openai`, `openai-compatible`, … */
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** Streaming completion. Yields `text_delta` events as text arrives and
   *  exactly one terminal `final` event carrying the full response.
   *  MAY THROW MID-ITERATION: vendors inject errors into an already-open
   *  stream (Anthropic sends `overloaded_error` after HTTP 200) — wrap the
   *  `for await` in try/catch. Retry-on-stream-error policy stays with the
   *  CALLER (it knows whether deltas were already forwarded to a user);
   *  `classifyError` supplies the vendor knowledge for that decision. */
  stream(req: LlmRequest): AsyncIterable<LlmStreamEvent>;
  classifyError(err: unknown): LlmErrorClassification;
}

// ---------------------------------------------------------------------------
// Content helpers (shared by adapters and consumers)
// ---------------------------------------------------------------------------

/** Concatenated text of all TextParts — the plain-text view of a response. */
export function collectText(content: ReadonlyArray<ContentPart>): string {
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

export function toolCalls(
  content: ReadonlyArray<ContentPart>,
): ReadonlyArray<ToolCallPart> {
  return content.filter(
    (part): part is ToolCallPart => part.type === 'tool_call',
  );
}

/** Convenience for plain-text conversations (the ctx.llm plugin path). */
export function textMessage(
  role: 'user' | 'assistant',
  text: string,
): ChatMessage {
  return { role, content: [{ type: 'text', text }] };
}
