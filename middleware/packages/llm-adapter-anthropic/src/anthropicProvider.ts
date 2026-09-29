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
} from '@omadia/llm-provider-api';

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

/**
 * `stop_details` → the neutral refusal object (#1219).
 *
 * The API populates `stop_details` ONLY for `stop_reason: 'refusal'` and leaves
 * it null everywhere else, so the stop reason is the gate — reading the field
 * unguarded would be a null deref on every normal turn. `category` is an open
 * vendor set (`bio`, `cyber`, `reasoning_extraction`, …) and may be absent, so
 * a refusal with no category still produces an object: its presence is the
 * signal, its contents are diagnostics.
 */
function toRefusal(
  message: Anthropic.Message,
): { category?: string; explanation?: string } | undefined {
  if (message.stop_reason !== 'refusal') return undefined;
  const details = (message as unknown as Record<string, unknown>)['stop_details'];
  if (details === null || typeof details !== 'object') return {};
  const { category, explanation } = details as Record<string, unknown>;
  return {
    ...(typeof category === 'string' ? { category } : {}),
    ...(typeof explanation === 'string' ? { explanation } : {}),
  };
}

function mapResponse(message: Anthropic.Message): LlmResponse {
  const usage = message.usage as unknown as Record<string, unknown>;
  const cacheWrite = usage['cache_creation_input_tokens'];
  const cacheRead = usage['cache_read_input_tokens'];
  const refusal = toRefusal(message);
  return {
    ...(refusal !== undefined ? { refusal } : {}),
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

/**
 * Model families that reject any `temperature` other than the default.
 *
 * Measured against the live API on 2026-08-19, because the rule is NOT
 * derivable from the version number and guessing it wrong fails a security
 * control silently:
 *
 * | model              | omitted | 0   | 0.5 | 1  |
 * |--------------------|---------|-----|-----|----|
 * | claude-opus-4-6    | OK      | OK  | OK  | OK |
 * | claude-opus-4-7    | OK      | 400 | 400 | OK |
 * | claude-opus-4-8    | OK      | 400 | 400 | OK |
 * | claude-opus-5      | OK      | 400 | 400 | OK |
 * | claude-sonnet-4-6  | OK      | OK  | OK  | OK |
 * | claude-sonnet-5    | OK      | 400 | 400 | OK |
 * | claude-haiku-4-5   | OK      | OK  | OK  | OK |
 *
 * Note `opus-4-6` accepts it while `opus-4-7` does not — so "newer than X"
 * is not the rule, and a version comparison would be a plausible, wrong gate.
 * `temperature: 1` is always accepted because it IS the default; the API only
 * objects to being asked for a value it no longer honours.
 */
const TEMPERATURE_UNSUPPORTED = [
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
];

/**
 * Whether this model still honours `temperature`.
 *
 * Exported for the test and for callers that want to know their determinism
 * request will be dropped. The match is a prefix so dated ids
 * (`claude-sonnet-5-20260101`) and provider-qualified ids resolve correctly.
 */
export function supportsTemperature(model: string): boolean {
  return !TEMPERATURE_UNSUPPORTED.some((m) => model.includes(m));
}

/**
 * Models that reject a FORCED `tool_choice` (`any` / `tool`) with a hard 400
 * (`tool_choice: type "tool" and "any" are not supported for this model.`).
 *
 * Measured against the live API on 2026-09-23:
 *
 * | model             | auto | any | tool |
 * |-------------------|------|-----|------|
 * | claude-opus-5     | OK   | OK  | OK   |
 * | claude-opus-5-5   | OK   | 400 | 400  |
 * | claude-fable-5-1  | OK   | 400 | 400  |
 *
 * Again not derivable from the version number (`opus-5` forces fine,
 * `opus-5-5` does not). Mythos 5.1 shares the Fable 5.1 API surface.
 */
const FORCED_TOOL_CHOICE_UNSUPPORTED = [
  'claude-opus-5-5',
  'claude-fable-5-1',
  'claude-mythos-5-1',
];

/** Whether this model accepts a forced `tool_choice` (`required` / `tool`). */
export function supportsForcedToolChoice(model: string): boolean {
  return !FORCED_TOOL_CHOICE_UNSUPPORTED.some((m) => model.includes(m));
}

/**
 * On models that reject forced tool use, a forced choice degrades to `auto`
 * (keeping `disableParallel`). Every caller that forces a tool already treats
 * "no tool_use in the response" as a normal outcome (reminder loop, fail-open
 * extractor/judge), whereas the 400 turned each of those paths into an
 * exception — the claim verifier and the card router went silently dark.
 */
function effectiveToolChoice(req: LlmRequest): ToolChoice | undefined {
  const choice = req.toolChoice;
  if (choice === undefined || supportsForcedToolChoice(req.model)) {
    return choice;
  }
  if (choice.type !== 'required' && choice.type !== 'tool') return choice;
  return choice.disableParallel === true
    ? { type: 'auto', disableParallel: true }
    : { type: 'auto' };
}

function buildParams(req: LlmRequest): Record<string, unknown> {
  const system = buildSystem(req);
  const toolChoice = effectiveToolChoice(req);
  const outputConfig = toOutputConfig(req);
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: toAnthropicMessages(req.messages),
    ...(system !== undefined ? { system } : {}),
    // Sending a temperature a model no longer honours is a hard 400, not a
    // warning. Callers ask for determinism (`temperature: 0`) on paths where
    // an exception degrades to fail-open — the security screener is one — so
    // dropping the parameter is strictly better than raising.
    ...(req.temperature !== undefined && supportsTemperature(req.model)
      ? { temperature: req.temperature }
      : {}),
    ...(req.tools !== undefined && req.tools.length > 0
      ? { tools: toAnthropicTools(req.tools, req.cacheHints) }
      : {}),
    ...(toolChoice !== undefined
      ? { tool_choice: toAnthropicToolChoice(toolChoice) }
      : {}),
    // #1033 — the normalized effort maps 1:1 onto Anthropic's
    // `output_config.effort` vocabulary (`low|medium|high|xhigh|max`); we
    // never send `max`, which the contract deliberately does not carry.
    // #1219 — `outputFormat` shares that object, so both are built together:
    // two spreads would make the second overwrite the first.
    ...(outputConfig !== undefined ? { output_config: outputConfig } : {}),
    // #1219 — server-side refusal fallback. `'default'` routes by refusal
    // category, so no model list is maintained here and none goes stale.
    ...(req.fallbacks !== undefined ? { fallbacks: req.fallbacks } : {}),
  };
}

/**
 * The `output_config` object, or undefined when the request carries neither an
 * effort nor an output format — so the common path sends no such key at all.
 *
 * `format` is the CURRENT structured-output shape (`{type:'json_schema',
 * schema}`), not the deprecated top-level `output_format` parameter. It is GA
 * on every model and needs no beta. Anthropic rejects it together with
 * document citations; nothing in this adapter sends citations today, so there
 * is no guard here — add one if citation support lands.
 */
function toOutputConfig(req: LlmRequest): Record<string, unknown> | undefined {
  const cfg: Record<string, unknown> = {
    ...(req.effort !== undefined ? { effort: req.effort } : {}),
    ...(req.outputFormat !== undefined
      ? {
          format: {
            type: req.outputFormat.type,
            schema: req.outputFormat.schema,
            ...(req.outputFormat.name !== undefined
              ? { name: req.outputFormat.name }
              : {}),
          },
        }
      : {}),
  };
  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/** The beta that unlocks the server-side refusal fallback (`fallbacks`).
 *  Attached only when a caller opts in, so the common path is untouched. */
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The beta that unlocked `output_config.effort`. Attached only when a request
 *  carries an effort AND the model still needs the opt-in, so the common path
 *  keeps its header set. */
export const EFFORT_BETA = 'effort-2025-11-24';

/**
 * Models that still need {@link EFFORT_BETA} to accept `output_config.effort`.
 *
 * Effort is GA from the 4.6 generation onward. Opus 4.5 shipped it behind the
 * beta and is not retired, so it keeps the opt-in. Sending the header to a GA
 * model is not an error, but it pins the request to a beta surface for no
 * reason — the newer models get the plain GA shape.
 */
const EFFORT_BETA_REQUIRED = ['claude-opus-4-5'];

/**
 * Whether `output_config.effort` needs its beta opt-in on this model.
 *
 * Exported for the test. The match is a substring so dated ids
 * (`claude-opus-4-5-20251101`) and provider-qualified ids resolve correctly.
 */
export function requiresEffortBeta(model: string): boolean {
  return EFFORT_BETA_REQUIRED.some((m) => model.includes(m));
}

/** Beta opt-ins → SDK request options (`anthropic-beta` header). Returns
 *  undefined when there are none, so callers pass nothing extra (preserving
 *  the no-options call shape for the common path). */
function toRequestOptions(
  req: LlmRequest,
): { headers: Record<string, string> } | undefined {
  const betas = [
    ...(req.betas ?? []),
    ...(req.effort !== undefined &&
    requiresEffortBeta(req.model) &&
    !(req.betas ?? []).includes(EFFORT_BETA)
      ? [EFFORT_BETA]
      : []),
    ...(req.fallbacks !== undefined &&
    !(req.betas ?? []).includes(SERVER_SIDE_FALLBACK_BETA)
      ? [SERVER_SIDE_FALLBACK_BETA]
      : []),
  ];
  return betas.length > 0
    ? { headers: { 'anthropic-beta': betas.join(',') } }
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
