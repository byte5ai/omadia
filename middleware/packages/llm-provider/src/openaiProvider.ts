/**
 * OpenAI adapter for the `LlmProvider` contract — the second reference
 * implementation after `anthropicProvider.ts`. It proves the neutral DTOs are
 * genuinely provider-agnostic (docs/plans/llm-provider-interface-plan.md, phase 3).
 *
 * Wire format: the **Chat Completions** API (`client.chat.completions.create`),
 * NOT the OpenAI-proprietary Responses API. Chat Completions is the lingua
 * franca that Mistral, Ollama, vLLM and Azure OpenAI all implement, so the same
 * adapter — pointed at a different `baseURL` — covers the whole OpenAI-compatible
 * family (id `openai-compatible`). All `openai` SDK knowledge lives HERE.
 *
 * Neutral ↔ OpenAI mapping notes:
 *  - Anthropic-style `ToolResultPart`s ride inside a neutral `user` message; OpenAI
 *    wants each as its own `{ role: 'tool', tool_call_id, content }` message, so a
 *    single neutral message can fan out to several OpenAI messages.
 *  - `ImagePart` → `{ type: 'image_url', image_url: { url: 'data:<mt>;base64,<data>' } }`.
 *  - A `ToolResultPart` carrying image parts is rejected (OpenAI tool messages are
 *    text-only) — never silently dropped, per the contract doc-note on the type.
 *  - `finishReason`: `length` → `max_tokens`; `tool_calls`/`function_call` →
 *    `tool_calls`; everything else → `stop`. If the response carries tool calls we
 *    force `tool_calls` even when the server reported `stop` (some OpenAI-compatible
 *    servers do), so the orchestrator's tool loop behaves like it does on Anthropic.
 *  - `betas` (no beta-header channel) and `cacheHints` (OpenAI caches automatically,
 *    not via hints) are ignored; `promptCaching` capability is reported `false` so
 *    callers know the hints are no-ops here.
 *  - `maxTokens` → `max_completion_tokens` on native OpenAI (GPT-5 / o-series
 *    REQUIRE it and reject `max_tokens`; gpt-4.x accept it too) and `max_tokens`
 *    on OpenAI-compatible servers (Mistral / Ollama / vLLM / Azure only speak
 *    the legacy param). Discriminated by the adapter id (`openai` vs not).
 */
import type OpenAI from 'openai';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';

import { createOpenAiClient } from './openaiClient.js';
import type {
  ChatMessage,
  ContentPart,
  FinishReason,
  ImagePart,
  LlmErrorClassification,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  ProviderCapabilities,
  SystemBlock,
  TextPart,
  ToolChoice,
  ToolResultPart,
  ToolSpec,
} from './types.js';

/** Provide EITHER a ready-made `client` OR an `apiKey` (+ optional `baseURL`) for
 *  the adapter to build one via `createOpenAiClient`. At least one is required;
 *  `client` wins if both are given. */
export interface OpenAiProviderOptions {
  /** A pre-built OpenAI SDK client (e.g. the kernel's shared instance). */
  readonly client?: OpenAI;
  /** API key to construct a client when `client` is not supplied. */
  readonly apiKey?: string;
  /** Base URL for OpenAI-compatible servers (Mistral/Ollama/vLLM/Azure). Only
   *  used when building a client from `apiKey`. Also flips the default id to
   *  `openai-compatible`. */
  readonly baseURL?: string;
  /** SDK auto-retry count when building a client from `apiKey`. */
  readonly maxRetries?: number;
  /** Override the adapter id. Defaults to `openai-compatible` when a `baseURL`
   *  is given, otherwise `openai`. */
  readonly id?: string;
  /** Override the advertised capabilities (OpenAI-compatible servers vary —
   *  e.g. Ollama models without vision or forced tool choice). */
  readonly capabilities?: Partial<ProviderCapabilities>;
  /** Emit OpenAI strict-mode function schemas (`function.strict = true`). Off by
   *  default: strict mode demands `additionalProperties: false` + every property
   *  required, which most tool schemas (and most OpenAI-compatible servers) do not
   *  satisfy. Opt in only when every tool schema is strict-clean. */
  readonly strictTools?: boolean;
  /** Quirk (OpenAI-compatible servers vary): which field carries the output-token
   *  cap. Defaults to `max_completion_tokens` for native OpenAI and `max_tokens`
   *  otherwise. MiniMax's modern endpoint deprecates `max_tokens` → set
   *  `max_completion_tokens`. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Quirk: omit `tool_choice` / `parallel_tool_calls` from requests. Some
   *  OpenAI-compatible servers (e.g. MiniMax) don't accept them and decide tool
   *  use autonomously; forwarding them risks a rejection. */
  readonly dropToolChoice?: boolean;
  /** Quirk: extra fields merged into every request body (e.g. MiniMax
   *  `{ reasoning_split: true }`). Merged last, so it can set vendor-only keys. */
  readonly extraBody?: Record<string, unknown>;
  /** Quirk: some servers (e.g. MiniMax) report errors via a `base_resp.status_code`
   *  field even on HTTP 200. When set, a non-zero `status_code` is thrown as a
   *  classified error instead of being mapped to a (wrong) clean response. */
  readonly checkBaseResp?: boolean;
  readonly log?: (...args: unknown[]) => void;
}

// OpenAI Chat Completions request fragments, kept structural so the adapter
// compiles against the type-only dependency without fighting the SDK's strict
// param unions (same approach as the Anthropic adapter).
type OpenAiMessageParam = Record<string, unknown>;

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  // OpenAI caches automatically; there are no caller-controllable hints, so the
  // CacheHints are silently ignored and the capability is reported false.
  promptCaching: false,
  forcedToolChoice: true,
  parallelToolCalls: true,
  // Chat Completions returns assistant `content` OR `tool_calls` per
  // completion, never both — so a sidecar tool the model is asked to call
  // alongside its answer (suggest_follow_ups) won't fire here. The orchestrator
  // reads this to run a post-turn card-router pass instead.
  interleavedToolUse: false,
};

// ---------------------------------------------------------------------------
// Request mapping (neutral → OpenAI Chat Completions)
// ---------------------------------------------------------------------------

function systemText(system: string | ReadonlyArray<SystemBlock>): string {
  return typeof system === 'string'
    ? system
    : system.map((b) => b.text).join('\n\n');
}

function imageUrl(part: ImagePart): string {
  return `data:${part.mediaType};base64,${part.data}`;
}

/** OpenAI tool messages are text-only. Collect the text; reject images loudly
 *  rather than dropping them (contract doc-note on ToolResultPart). */
function toolResultText(part: ToolResultPart): string {
  if (typeof part.content === 'string') return part.content;
  const hasImage = part.content.some((p) => p.type === 'image');
  if (hasImage) {
    throw new Error(
      `OpenAI tool results are text-only, but the result for tool_call ${part.toolCallId} contains an image part. The OpenAI Chat Completions API cannot attach images to a 'tool' message.`,
    );
  }
  return part.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('');
}

/** Map the text/image parts of a user message to OpenAI content. Returns a
 *  plain string when it is a single text part (the common, widely-compatible
 *  shape), otherwise the structured content-part array. */
function toUserContent(
  parts: ReadonlyArray<TextPart | ImagePart>,
): string | OpenAiMessageParam[] {
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: imageUrl(p) } },
  );
}

function assistantToolCalls(
  parts: ReadonlyArray<ContentPart>,
): OpenAiMessageParam[] {
  return parts
    .filter((p) => p.type === 'tool_call')
    .map((p) => {
      const call = p as Extract<ContentPart, { type: 'tool_call' }>;
      return {
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        },
      };
    });
}

/** One neutral message can fan out to several OpenAI messages: each
 *  `ToolResultPart` becomes its own `role:'tool'` message, while the remaining
 *  text/image (user) or text/tool_call (assistant) parts form one message. */
function toOpenAiMessages(
  messages: ReadonlyArray<ChatMessage>,
): OpenAiMessageParam[] {
  const out: OpenAiMessageParam[] = [];
  for (const m of messages) {
    // Tool results first — they answer the immediately-preceding assistant
    // tool_calls and must keep that adjacency.
    for (const part of m.content) {
      if (part.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content: toolResultText(part),
        });
      }
    }
    if (m.role === 'assistant') {
      const textParts = m.content.filter(
        (p): p is TextPart => p.type === 'text',
      );
      const toolCalls = assistantToolCalls(m.content);
      const text = textParts.map((p) => p.text).join('');
      if (text.length > 0 || toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          // content must be present; null is valid alongside tool_calls.
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    } else {
      const visible = m.content.filter(
        (p): p is TextPart | ImagePart =>
          p.type === 'text' || p.type === 'image',
      );
      if (visible.length > 0) {
        out.push({ role: 'user', content: toUserContent(visible) });
      }
    }
  }
  return out;
}

/** Canonical empty parameters schema for a no-argument tool. OpenAI tolerates
 *  an omitted/undefined `parameters`, but stricter OpenAI-compatible servers
 *  (Mistral) reject a function with no valid `parameters` object with a bare
 *  422 — so always emit a valid JSON Schema object. A no-arg tool is identical
 *  to omitting `parameters` on native OpenAI, so this is behavior-preserving. */
const EMPTY_TOOL_PARAMETERS = { type: 'object', properties: {} } as const;

function toOpenAiTools(
  tools: ReadonlyArray<ToolSpec>,
  strict: boolean,
): OpenAiMessageParam[] {
  return tools
    // Provider-native server tools (e.g. Anthropic's memory tool) have no
    // OpenAI equivalent — skip them rather than emit a bogus empty-param
    // function the model would never be able to call correctly.
    .filter((t) => t.serverType === undefined)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema ?? EMPTY_TOOL_PARAMETERS,
        ...(strict ? { strict: true } : {}),
      },
    }));
}

function toOpenAiToolChoice(choice: ToolChoice): unknown {
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'required':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
  }
}

/** `disableParallel` lives on the neutral ToolChoice but maps to OpenAI's
 *  top-level `parallel_tool_calls`, which is only valid when tools are sent. */
function disablesParallel(choice: ToolChoice | undefined): boolean {
  return (
    choice !== undefined &&
    choice.type !== 'none' &&
    choice.disableParallel === true
  );
}

interface BuildParamsQuirks {
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  readonly dropToolChoice?: boolean;
  readonly extraBody?: Record<string, unknown>;
}

function buildParams(
  req: LlmRequest,
  strictTools: boolean,
  nativeOpenAi: boolean,
  quirks?: BuildParamsQuirks,
): Record<string, unknown> {
  const messages: OpenAiMessageParam[] = [];
  if (req.system !== undefined) {
    messages.push({ role: 'system', content: systemText(req.system) });
  }
  messages.push(...toOpenAiMessages(req.messages));

  const tools = req.tools;
  const hasTools = tools !== undefined && tools.length > 0;
  // Native OpenAI requires `max_completion_tokens` (GPT-5 / o-series reject
  // `max_tokens`; gpt-4.x accept it too). OpenAI-compatible servers
  // (Mistral / Ollama / vLLM / Azure) only speak the legacy `max_tokens`. A
  // provider may override the field explicitly (MiniMax → max_completion_tokens).
  const maxTokensKey =
    quirks?.maxTokensField ??
    (nativeOpenAi ? 'max_completion_tokens' : 'max_tokens');
  const dropToolChoice = quirks?.dropToolChoice === true;
  return {
    model: req.model,
    messages,
    [maxTokensKey]: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(hasTools ? { tools: toOpenAiTools(tools, strictTools) } : {}),
    // tool_choice (incl. parallel_tool_calls) is only valid alongside tools —
    // OpenAI rejects 'required'/named/`parallel_tool_calls` with no tools, so a
    // tool choice without tools is dropped rather than forwarded as an error.
    // Some compatible servers (MiniMax) reject these fields entirely → dropped.
    ...(!dropToolChoice && hasTools && req.toolChoice !== undefined
      ? { tool_choice: toOpenAiToolChoice(req.toolChoice) }
      : {}),
    ...(!dropToolChoice && hasTools && disablesParallel(req.toolChoice)
      ? { parallel_tool_calls: false }
      : {}),
    // Vendor-only request fields (e.g. MiniMax `reasoning_split`). Merged last.
    ...(quirks?.extraBody ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Response mapping (OpenAI → neutral)
// ---------------------------------------------------------------------------

/** OpenAI returns tool arguments as a JSON string. Parse it; on malformed JSON
 *  (a model/server error) keep the raw string so nothing is silently lost. */
function parseToolArgs(args: string | undefined): unknown {
  if (args === undefined || args === '') return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function mapFinishReason(
  raw: string | null | undefined,
  hasToolCalls: boolean,
): { finishReason: FinishReason; providerFinishReason?: string } {
  // Tool calls present always means the loop should run tools — mirror Anthropic
  // `tool_use` even if a compatible server mislabels the finish_reason as 'stop'.
  if (hasToolCalls) {
    return {
      finishReason: 'tool_calls',
      ...(raw != null ? { providerFinishReason: raw } : {}),
    };
  }
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return { finishReason: 'tool_calls', providerFinishReason: raw };
    case 'length':
      return { finishReason: 'max_tokens', providerFinishReason: raw };
    case 'stop':
    case 'content_filter':
      return { finishReason: 'stop', providerFinishReason: raw };
    default:
      return {
        finishReason: 'stop',
        ...(raw != null ? { providerFinishReason: raw } : {}),
      };
  }
}

interface OpenAiUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

function mapUsage(usage: OpenAiUsageShape | null | undefined): LlmResponse['usage'] {
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    // OpenAI has no cache-WRITE token concept (caching is automatic); only the
    // read side is reported.
    ...(typeof cached === 'number' ? { cacheReadTokens: cached } : {}),
  };
}

function mapResponse(completion: OpenAI.Chat.Completions.ChatCompletion): LlmResponse {
  // An empty choices array is not a valid completion — surface it so the
  // caller's retry/error path engages instead of seeing a clean empty turn.
  if (!completion.choices || completion.choices.length === 0) {
    throw new Error('OpenAI completion contained no choices');
  }
  const choice = completion.choices[0];
  const message = choice?.message;
  const content: ContentPart[] = [];
  if (message?.content) {
    content.push({ type: 'text', text: message.content });
  } else if (message?.refusal) {
    // A structured refusal (content is null) is user-facing, not an internal
    // reasoning block — surface it as text rather than dropping it.
    content.push({ type: 'text', text: message.refusal });
  }
  const toolCalls = message?.tool_calls ?? [];
  for (const tc of toolCalls) {
    if (tc.type !== 'function') continue;
    content.push({
      type: 'tool_call',
      id: tc.id,
      name: tc.function.name,
      input: parseToolArgs(tc.function.arguments),
    });
  }
  return {
    content,
    ...mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
    model: completion.model,
    usage: mapUsage(completion.usage),
  };
}

// ---------------------------------------------------------------------------
// Streaming accumulator
// ---------------------------------------------------------------------------

interface ToolAcc {
  id?: string;
  name: string;
  args: string;
}

// ---------------------------------------------------------------------------
// Error classification — OpenAI APIError taxonomy. Status-first (the reliable
// signal: 429/401/403/5xx all carry one), then `code`, then a connection-error
// check by SDK class + the underlying socket error in `.cause` (the OpenAI SDK
// leaves `.name === 'Error'` and `status/code` undefined on connection/timeout
// errors, stashing the real cause on `.cause`).
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]);
const RETRYABLE_CAUSE_CODE =
  /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|ECONNREFUSED|EAI_AGAIN)$/;

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as Record<string, unknown>)['status'];
  return typeof status === 'number' ? status : undefined;
}

/** OpenAI's machine-readable identifier is `err.code` (e.g.
 *  `rate_limit_exceeded`, `invalid_api_key`), mirrored at `err.error.code` on
 *  the raw body. `type` is a coarse category, not a code, so it is ignored. */
function extractCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e['code'] === 'string') return e['code'];
  const nested = e['error'];
  if (typeof nested === 'object' && nested !== null) {
    const v = (nested as Record<string, unknown>)['code'];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** A genuine transport failure (no HTTP response): the SDK's connection-error
 *  classes, or any object whose `.cause` carries a retryable socket errno. */
function isConnectionError(err: unknown): boolean {
  if (
    err instanceof APIConnectionError ||
    err instanceof APIConnectionTimeoutError
  ) {
    return true;
  }
  if (typeof err === 'object' && err !== null) {
    const cause = (err as { cause?: unknown }).cause;
    if (typeof cause === 'object' && cause !== null) {
      const code = (cause as Record<string, unknown>)['code'];
      if (typeof code === 'string' && RETRYABLE_CAUSE_CODE.test(code)) {
        return true;
      }
    }
  }
  return false;
}

export function classifyOpenAiError(err: unknown): LlmErrorClassification {
  const status = extractStatus(err);
  const code = extractCode(err);

  if (status === 429 || code === 'rate_limit_exceeded') {
    return { retryable: true, kind: 'rate_limit' };
  }
  if (status === 529 || code === 'overloaded') {
    return { retryable: true, kind: 'overloaded' };
  }
  if (
    status === 401 ||
    status === 403 ||
    code === 'invalid_api_key' ||
    code === 'authentication_error' ||
    code === 'permission_denied'
  ) {
    return { retryable: false, kind: 'auth' };
  }
  if (
    (status !== undefined && RETRYABLE_STATUS.has(status)) ||
    isConnectionError(err)
  ) {
    return { retryable: true, kind: 'other' };
  }
  return { retryable: false, kind: 'other' };
}

// ---------------------------------------------------------------------------
// base_resp quirk (MiniMax): an in-body status that can flag an error on HTTP 200
// ---------------------------------------------------------------------------

interface BaseResp {
  status_code?: number;
  status_msg?: string;
}

/** Map a MiniMax `base_resp.status_code` onto an HTTP-ish status so the existing
 *  `classifyOpenAiError` routes retry/auth correctly. Codes per MiniMax docs. */
const BASE_RESP_STATUS: Readonly<Record<number, number>> = {
  1002: 429, // rate limit → retryable
  1004: 401, // auth failed → non-retryable auth
  1008: 401, // insufficient balance → non-retryable auth
  1013: 500, // internal error → retryable
  1000: 500, // unknown → retryable
  1001: 503, // timeout → retryable
  1039: 400, // token limit exceeded → non-retryable
  2013: 400, // parameter error → non-retryable
  1027: 400, // output content error → non-retryable
};

/** Return a classified Error for a non-zero `base_resp`, or `undefined` when the
 *  call succeeded (`status_code` 0 / absent). The returned error carries a
 *  numeric `.status` so `classifyOpenAiError` can route it. */
function baseRespError(
  base: BaseResp | undefined | null,
): (Error & { status?: number; code?: string }) | undefined {
  const code = base?.status_code;
  if (typeof code !== 'number' || code === 0) return undefined;
  const err = new Error(
    `MiniMax base_resp error ${String(code)}${base?.status_msg ? `: ${base.status_msg}` : ''}`,
  ) as Error & { status?: number; code?: string };
  const mapped = BASE_RESP_STATUS[code];
  if (mapped !== undefined) err.status = mapped;
  err.code = `base_resp_${String(code)}`;
  return err;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createOpenAiProvider(opts: OpenAiProviderOptions): LlmProvider {
  let client: OpenAI;
  if (opts.client !== undefined) {
    client = opts.client;
  } else if (opts.apiKey !== undefined) {
    client = createOpenAiClient({
      apiKey: opts.apiKey,
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    });
  } else {
    throw new Error(
      'createOpenAiProvider requires either { client } or { apiKey }.',
    );
  }

  const log = opts.log ?? (() => {});
  const usesBaseURL = opts.client === undefined && opts.baseURL !== undefined;
  const id = opts.id ?? (usesBaseURL ? 'openai-compatible' : 'openai');
  const capabilities: ProviderCapabilities = {
    ...DEFAULT_CAPABILITIES,
    ...(opts.capabilities ?? {}),
  };
  const strictTools = opts.strictTools === true;
  const checkBaseResp = opts.checkBaseResp === true;
  const quirks: BuildParamsQuirks = {
    ...(opts.maxTokensField !== undefined
      ? { maxTokensField: opts.maxTokensField }
      : {}),
    ...(opts.dropToolChoice !== undefined
      ? { dropToolChoice: opts.dropToolChoice }
      : {}),
    ...(opts.extraBody !== undefined ? { extraBody: opts.extraBody } : {}),
  };

  const paramsFor = (req: LlmRequest): Record<string, unknown> =>
    buildParams(req, strictTools, id === 'openai', quirks);

  return {
    id,
    capabilities,

    async complete(req: LlmRequest): Promise<LlmResponse> {
      const started = Date.now();
      const params = paramsFor(req) as unknown as Parameters<
        typeof client.chat.completions.create
      >[0];
      const completion = (await client.chat.completions.create(
        params,
      )) as OpenAI.Chat.Completions.ChatCompletion;
      if (checkBaseResp) {
        const be = baseRespError(
          (completion as unknown as { base_resp?: BaseResp }).base_resp,
        );
        if (be) throw be;
      }
      const mapped = mapResponse(completion);
      log(
        `complete ok id=${id} model=${mapped.model} in=${String(mapped.usage.inputTokens)} out=${String(mapped.usage.outputTokens)} ms=${String(Date.now() - started)}`,
      );
      return mapped;
    },

    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      const params = {
        ...paramsFor(req),
        stream: true,
        // Ask for the trailing usage chunk so token accounting matches complete().
        stream_options: { include_usage: true },
      } as unknown as Parameters<typeof client.chat.completions.create>[0];

      const stream = (await client.chat.completions.create(
        params,
      )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

      let text = '';
      let refusal = '';
      let model = req.model;
      let rawFinish: string | null = null;
      let usage: OpenAiUsageShape | null | undefined;
      let baseResp: BaseResp | undefined;
      const toolAcc = new Map<number, ToolAcc>();
      const started = new Set<number>();

      for await (const chunk of stream) {
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage as OpenAiUsageShape;
        if (checkBaseResp) {
          const br = (chunk as unknown as { base_resp?: BaseResp }).base_resp;
          if (br) baseResp = br;
        }
        // Optional-chain `choices`: OpenAI-compatible servers (Mistral/Ollama/
        // vLLM/Azure) often send the trailing include_usage chunk with NO
        // `choices` key at all, not just an empty array — `choices[0]` would throw.
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          yield { type: 'text_delta', text: delta.content };
        }
        if (typeof delta?.refusal === 'string') {
          refusal += delta.refusal;
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index;
          let entry = toolAcc.get(idx);
          if (entry === undefined) {
            entry = { name: '', args: '' };
            toolAcc.set(idx, entry);
          }
          if (tc.id !== undefined) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (!started.has(idx)) {
            started.add(idx);
            yield { type: 'tool_use_start' };
          }
          if (tc.function?.arguments) {
            entry.args += tc.function.arguments;
            yield { type: 'tool_input_delta', text: tc.function.arguments };
          }
        }
        if (choice.finish_reason) rawFinish = choice.finish_reason;
      }

      // A non-zero base_resp (MiniMax) flags an error even when the stream
      // completed — surface it so the caller's retry/error path engages.
      if (checkBaseResp) {
        const be = baseRespError(baseResp);
        if (be) throw be;
      }

      const content: ContentPart[] = [];
      if (text.length > 0) {
        content.push({ type: 'text', text });
      } else if (refusal.length > 0) {
        // Surface a streamed refusal as text rather than dropping it (parity
        // with the non-streaming path).
        content.push({ type: 'text', text: refusal });
      }
      for (const [idx, entry] of [...toolAcc.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        content.push({
          type: 'tool_call',
          id: entry.id ?? `call_${String(idx)}`,
          name: entry.name,
          input: parseToolArgs(entry.args),
        });
      }
      const response: LlmResponse = {
        content,
        ...mapFinishReason(rawFinish, toolAcc.size > 0),
        model,
        usage: mapUsage(usage),
      };
      yield { type: 'final', response };
    },

    classifyError: classifyOpenAiError,
  };
}
