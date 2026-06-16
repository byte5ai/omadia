/**
 * Anthropic reference adapter for the `LlmProvider` contract.
 *
 * All `@anthropic-ai/sdk` knowledge of the middleware is meant to end up
 * HERE (phase 2 of docs/plans/llm-provider-interface-plan.md migrates the
 * orchestrator/streaming call-sites onto this adapter): message/content
 * mapping, `cache_control`, stop_reason normalisation, and the retryable
 * error taxonomy that `streaming.ts` historically owned.
 */
import type Anthropic from '@anthropic-ai/sdk';

import type {
  CacheHints,
  ChatMessage,
  ContentPart,
  FinishReason,
  LlmErrorClassification,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  ImagePart,
  TextPart,
  ToolChoice,
  ToolSpec,
} from './types.js';

export interface AnthropicProviderOptions {
  readonly client: Anthropic;
  readonly log?: (...args: unknown[]) => void;
}

// Anthropic SDK request fragments, kept structural (no SDK value imports)
// so the adapter compiles against the type-only dependency.
type AnthropicContentBlockParam = Record<string, unknown>;
type AnthropicMessageParam = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlockParam[];
};

const CACHE_EPHEMERAL = { type: 'ephemeral' } as const;

/** Narrow mapper for nested tool_result content — the type signature
 *  enforces Anthropic's constraint that tool results may only nest
 *  text/image blocks, never tool_use/tool_result. */
function toAnthropicResultPart(
  part: TextPart | ImagePart,
): AnthropicContentBlockParam {
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mediaType,
          data: part.data,
        },
      };
}

function toAnthropicPart(part: ContentPart): AnthropicContentBlockParam {
  switch (part.type) {
    case 'text':
    case 'image':
      return toAnthropicResultPart(part);
    case 'tool_call':
      return {
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: part.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content:
          typeof part.content === 'string'
            ? part.content
            : part.content.map(toAnthropicResultPart),
        ...(part.isError !== undefined ? { is_error: part.isError } : {}),
      };
  }
}

function toAnthropicMessages(
  messages: ReadonlyArray<ChatMessage>,
): AnthropicMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map(toAnthropicPart),
  }));
}

function toAnthropicTools(
  tools: ReadonlyArray<ToolSpec>,
  cacheHints: CacheHints | undefined,
): AnthropicContentBlockParam[] {
  return tools.map((tool, i) => {
    // Caching the LAST tool caches everything up to that point — the
    // stable prefix across tool-loop iterations (localSubAgent convention).
    const cache =
      cacheHints?.tools === true && i === tools.length - 1
        ? { cache_control: CACHE_EPHEMERAL }
        : {};
    // Provider-native server tool (memory, web_search, …): typed, schema
    // owned server side. Emit the `{ type, name }` shape — a custom-tool
    // `input_schema` would be rejected by the API for these.
    if (tool.serverType !== undefined) {
      return { type: tool.serverType, name: tool.name, ...cache };
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...cache,
    };
  });
}

function toAnthropicToolChoice(
  choice: ToolChoice,
): Record<string, unknown> | undefined {
  const noParallel = (flag: boolean | undefined) =>
    flag === true ? { disable_parallel_tool_use: true } : {};
  switch (choice.type) {
    case 'auto':
      return { type: 'auto', ...noParallel(choice.disableParallel) };
    case 'none':
      return { type: 'none' };
    case 'required':
      return { type: 'any', ...noParallel(choice.disableParallel) };
    case 'tool':
      return {
        type: 'tool',
        name: choice.name,
        ...noParallel(choice.disableParallel),
      };
  }
}

function fromAnthropicContent(
  content: ReadonlyArray<{ type: string } & Record<string, unknown>>,
): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block['text'] as string });
    } else if (block.type === 'tool_use') {
      parts.push({
        type: 'tool_call',
        id: block['id'] as string,
        name: block['name'] as string,
        input: block['input'],
      });
    }
    // thinking/redacted blocks are intentionally dropped from the neutral
    // view — phase-2 callers that need them read providerFinishReason and
    // raw usage instead; revisit when a second provider exposes reasoning.
  }
  return parts;
}

function mapFinishReason(stopReason: string | null | undefined): {
  finishReason: FinishReason;
  providerFinishReason?: string;
} {
  switch (stopReason) {
    case 'tool_use':
      return { finishReason: 'tool_calls', providerFinishReason: stopReason };
    case 'max_tokens':
      return { finishReason: 'max_tokens', providerFinishReason: stopReason };
    case 'end_turn':
    case 'stop_sequence':
      return { finishReason: 'stop', providerFinishReason: stopReason };
    default:
      // null happens on some streaming edge-cases; treat as natural stop.
      return {
        finishReason: 'stop',
        ...(stopReason != null ? { providerFinishReason: stopReason } : {}),
      };
  }
}

function mapResponse(message: Anthropic.Message): LlmResponse {
  const usage = message.usage as unknown as Record<string, unknown>;
  const cacheWrite = usage['cache_creation_input_tokens'];
  const cacheRead = usage['cache_read_input_tokens'];
  return {
    content: fromAnthropicContent(
      message.content as unknown as Array<
        { type: string } & Record<string, unknown>
      >,
    ),
    ...mapFinishReason(message.stop_reason),
    model: message.model,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      ...(typeof cacheWrite === 'number'
        ? { cacheWriteTokens: cacheWrite }
        : {}),
      ...(typeof cacheRead === 'number' ? { cacheReadTokens: cacheRead } : {}),
    },
  };
}

/** Maps the neutral `system` (plain string or structured blocks) to the
 *  Anthropic `system` arg. A plain string honours `cacheHints.system`; a block
 *  array carries its own per-block cache breakpoints (cacheHints ignored). */
function buildSystem(req: LlmRequest): unknown {
  const { system } = req;
  if (system === undefined) return undefined;
  if (typeof system === 'string') {
    return req.cacheHints?.system === true
      ? [{ type: 'text', text: system, cache_control: CACHE_EPHEMERAL }]
      : system;
  }
  return system.map((b) => ({
    type: 'text',
    text: b.text,
    ...(b.cache === true ? { cache_control: CACHE_EPHEMERAL } : {}),
  }));
}

function buildParams(req: LlmRequest): Record<string, unknown> {
  const system = buildSystem(req);
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: toAnthropicMessages(req.messages),
    ...(system !== undefined ? { system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.tools !== undefined && req.tools.length > 0
      ? { tools: toAnthropicTools(req.tools, req.cacheHints) }
      : {}),
    ...(req.toolChoice !== undefined
      ? { tool_choice: toAnthropicToolChoice(req.toolChoice) }
      : {}),
  };
}

/** Beta opt-ins → SDK request options (`anthropic-beta` header). Returns
 *  undefined when there are none, so callers pass nothing extra (preserving
 *  the no-options call shape for the common path). */
function toRequestOptions(
  req: LlmRequest,
): { headers: Record<string, string> } | undefined {
  return req.betas !== undefined && req.betas.length > 0
    ? { headers: { 'anthropic-beta': req.betas.join(',') } }
    : undefined;
}

// ---------------------------------------------------------------------------
// Error classification — semantics ported from the historical
// `isRetryableStreamError()` in harness-orchestrator/src/streaming.ts:
// nested ({type:'error',error:{type}}), flattened ({type}), and raw
// message-text shapes all occur in practice.
// ---------------------------------------------------------------------------

const RETRYABLE_ERROR_TYPES = new Set([
  'overloaded_error',
  'rate_limit_error',
  'api_error',
]);
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]);
// Last-resort raw-message scan, derived from the set so the two can
// never drift (mid-stream errors often surface as bare Error('{"type":…')).
const RETRYABLE_TYPE_TEXT = new RegExp([...RETRYABLE_ERROR_TYPES].join('|'));

function extractErrorType(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  const nested = e['error'];
  if (typeof nested === 'object' && nested !== null) {
    const inner = (nested as Record<string, unknown>)['error'];
    if (typeof inner === 'object' && inner !== null) {
      const t = (inner as Record<string, unknown>)['type'];
      if (typeof t === 'string') return t;
    }
    const t = (nested as Record<string, unknown>)['type'];
    if (typeof t === 'string' && t !== 'error') return t;
  }
  const t = e['type'];
  if (typeof t === 'string' && t !== 'error') return t;
  return undefined;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const status = (err as Record<string, unknown>)['status'];
  return typeof status === 'number' ? status : undefined;
}

export function classifyAnthropicError(err: unknown): LlmErrorClassification {
  const type = extractErrorType(err);
  const status = extractStatus(err);
  const message = err instanceof Error ? err.message : String(err ?? '');

  if (type === 'rate_limit_error' || status === 429) {
    return { retryable: true, kind: 'rate_limit' };
  }
  if (type === 'overloaded_error' || status === 529) {
    return { retryable: true, kind: 'overloaded' };
  }
  if (
    type === 'authentication_error' ||
    type === 'permission_error' ||
    status === 401 ||
    status === 403
  ) {
    return { retryable: false, kind: 'auth' };
  }
  if (
    (type !== undefined && RETRYABLE_ERROR_TYPES.has(type)) ||
    (status !== undefined && RETRYABLE_STATUS.has(status)) ||
    RETRYABLE_TYPE_TEXT.test(message)
  ) {
    return { retryable: true, kind: 'other' };
  }
  return { retryable: false, kind: 'other' };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createAnthropicProvider(
  opts: AnthropicProviderOptions,
): LlmProvider {
  const { client } = opts;
  const log = opts.log ?? (() => {});

  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
      // Claude emits natural-language text alongside tool_use in one assistant
      // message, so sidecar tools (suggest_follow_ups) fire inline — no
      // post-turn card-router pass needed.
      interleavedToolUse: true,
    },

    async complete(req: LlmRequest): Promise<LlmResponse> {
      const started = Date.now();
      const params = buildParams(req) as unknown as Parameters<
        typeof client.messages.create
      >[0];
      const options = toRequestOptions(req);
      const response = await (options !== undefined
        ? client.messages.create(params, options)
        : client.messages.create(params));
      const mapped = mapResponse(response as Anthropic.Message);
      log(
        `complete ok model=${mapped.model} in=${String(mapped.usage.inputTokens)} out=${String(mapped.usage.outputTokens)} ms=${String(Date.now() - started)}`,
      );
      return mapped;
    },

    async *stream(req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      const params = buildParams(req) as unknown as Parameters<
        typeof client.messages.stream
      >[0];
      const options = toRequestOptions(req);
      const stream = options !== undefined
        ? client.messages.stream(params, options)
        : client.messages.stream(params);
      for await (const event of stream) {
        if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use'
        ) {
          yield { type: 'tool_use_start' };
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            yield { type: 'tool_input_delta', text: event.delta.partial_json };
          }
        }
      }
      const final = await stream.finalMessage();
      yield { type: 'final', response: mapResponse(final) };
    },

    classifyError: classifyAnthropicError,
  };
}
