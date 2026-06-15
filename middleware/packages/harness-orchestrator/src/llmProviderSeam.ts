/**
 * Provider seam for the orchestrator + local sub-agent.
 *
 * The orchestrator and `LocalSubAgent` run an intricate, loosely-typed
 * (`ContentBlock = any`) tool loop that BUILDS Anthropic-shaped request params
 * and READS Anthropic-shaped responses (`response.content` blocks,
 * `stop_reason`, snake_case `usage`). Rewriting that loop to speak the neutral
 * `@omadia/llm-provider` DTOs natively would mean editing dozens of untyped
 * read/write sites with no compiler safety net — exactly where a
 * zero-behavior-change refactor goes wrong.
 *
 * Instead we keep the loop's internal Anthropic shape untouched and translate
 * ONLY at the provider boundary (phase 2b of
 * docs/plans/llm-provider-interface-plan.md):
 *
 *   orchestrator params (Anthropic shape)
 *        → toLlmRequest →  LlmRequest (neutral)
 *        → provider.complete/stream → adapter → vendor
 *   vendor response → adapter → LlmResponse (neutral)
 *        → fromLlmResponse → Anthropic-shaped message (what the loop reads)
 *
 * For the Anthropic adapter this round-trips to (semantically) the same wire
 * shape it sent before — verified by the round-trip unit tests. For a future
 * provider the neutral request is what the OpenAI/etc. adapter consumes, so the
 * orchestrator's "Anthropic-shaped internal format" is just a convenient
 * intermediate, not a coupling.
 */
import type {
  ChatMessage,
  ContentPart,
  FinishReason,
  ImagePart,
  LlmRequest,
  LlmResponse,
  SystemBlock,
  TextPart,
  ToolCallPart,
  ToolChoice,
  ToolResultPart,
  ToolSpec,
} from '@omadia/llm-provider';

// The orchestrator's loosely-typed Anthropic shapes. Mirrors its own
// `type ContentBlock = any` — we narrow structurally inside the mappers.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnthropicBlock = Record<string, any>;
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}
export interface AnthropicParams {
  model: string;
  max_tokens: number;
  system?: string | AnthropicBlock[];
  tools?: AnthropicBlock[];
  tool_choice?: Record<string, any>;
  messages: AnthropicMessage[];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Outbound: Anthropic-shaped params (built by the loop) → neutral LlmRequest
// ---------------------------------------------------------------------------

function toContentPart(block: AnthropicBlock): ContentPart {
  switch (block['type']) {
    case 'text':
      return { type: 'text', text: block['text'] as string };
    case 'image': {
      const source = (block['source'] ?? {}) as Record<string, unknown>;
      return {
        type: 'image',
        mediaType: source['media_type'] as string,
        data: source['data'] as string,
      };
    }
    case 'tool_use':
      return {
        type: 'tool_call',
        id: block['id'] as string,
        name: block['name'] as string,
        input: block['input'],
      };
    case 'tool_result': {
      const content = block['content'];
      const part: ToolResultPart = {
        type: 'tool_result',
        toolCallId: block['tool_use_id'] as string,
        content:
          typeof content === 'string'
            ? content
            : (content as AnthropicBlock[]).map(
                (b) => toContentPart(b) as TextPart | ImagePart,
              ),
        ...(block['is_error'] !== undefined
          ? { isError: block['is_error'] as boolean }
          : {}),
      };
      return part;
    }
    default:
      // thinking/redacted or unknown blocks have no neutral equivalent; the
      // orchestrator never echoes them back into a request, but be lenient.
      return { type: 'text', text: '' };
  }
}

function toChatMessage(message: AnthropicMessage): ChatMessage {
  const content: ContentPart[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content.map(toContentPart);
  return { role: message.role, content };
}

function toSystem(
  system: AnthropicParams['system'],
): string | ReadonlyArray<SystemBlock> | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return system.map((block) => ({
    text: block['text'] as string,
    ...(block['cache_control'] !== undefined ? { cache: true } : {}),
  }));
}

function toToolSpecs(tools: AnthropicBlock[]): {
  tools: ToolSpec[];
  cacheTools: boolean;
} {
  let cacheTools = false;
  const specs = tools.map((tool) => {
    if (tool['cache_control'] !== undefined) cacheTools = true;
    const inputSchema = tool['input_schema'] as
      | Record<string, unknown>
      | undefined;
    // Provider-native server tools (Anthropic memory `memory_20250818`,
    // web_search, …) carry a `type` discriminator and NO `input_schema` —
    // the vendor owns the schema. Preserve `type` so the adapter re-emits
    // the server-tool shape; dropping it produced a custom tool with a
    // missing input_schema → 400 `tools.0.custom.input_schema: Field required`.
    if (inputSchema === undefined && typeof tool['type'] === 'string') {
      return {
        name: tool['name'] as string,
        description: (tool['description'] ?? '') as string,
        inputSchema: {} as Record<string, unknown>,
        serverType: tool['type'] as string,
      };
    }
    return {
      name: tool['name'] as string,
      description: (tool['description'] ?? '') as string,
      inputSchema: inputSchema as Record<string, unknown>,
    };
  });
  return { tools: specs, cacheTools };
}

function toToolChoice(
  choice: Record<string, unknown> | undefined,
): ToolChoice | undefined {
  if (choice === undefined) return undefined;
  const par: { disableParallel?: true } =
    choice['disable_parallel_tool_use'] === true ? { disableParallel: true } : {};
  switch (choice['type']) {
    case 'auto':
      return { type: 'auto', ...par };
    case 'any':
      return { type: 'required', ...par };
    case 'tool':
      return { type: 'tool', name: choice['name'] as string, ...par };
    case 'none':
      return { type: 'none' };
    default:
      return undefined;
  }
}

/**
 * Translate the Anthropic-shaped params the orchestrator/sub-agent built into
 * a neutral `LlmRequest`. `betas` carries provider preview opt-ins (the
 * orchestrator's `context-management` beta) that previously rode as the
 * `anthropic-beta` request header.
 */
export function toLlmRequest(
  params: AnthropicParams,
  betas?: ReadonlyArray<string>,
): LlmRequest {
  const system = toSystem(params.system);
  const toolChoice = toToolChoice(params.tool_choice);
  const tooling =
    params.tools !== undefined && params.tools.length > 0
      ? toToolSpecs(params.tools)
      : undefined;
  return {
    model: params.model,
    maxTokens: params.max_tokens,
    messages: params.messages.map(toChatMessage),
    ...(system !== undefined ? { system } : {}),
    ...(tooling !== undefined ? { tools: tooling.tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(tooling?.cacheTools === true
      ? { cacheHints: { tools: true } }
      : {}),
    ...(betas !== undefined && betas.length > 0 ? { betas } : {}),
  };
}

// ---------------------------------------------------------------------------
// Inbound: neutral LlmResponse → the Anthropic-shaped message the loop reads
// ---------------------------------------------------------------------------

/** The Anthropic `stop_reason` vocabulary the orchestrator/sub-agent loop reads
 *  back. The Anthropic adapter's `providerFinishReason` is already one of these,
 *  so it round-trips unchanged (preserving `end_turn` vs `stop_sequence`). A raw
 *  value NOT in this set — e.g. OpenAI's `tool_calls`/`length`/`stop` — is a
 *  FOREIGN vocabulary and must NOT pass through: the loop dispatches tools only
 *  on `stop_reason === 'tool_use'`, so a raw `tool_calls` would make every
 *  OpenAI tool call silently drop (empty answer). Normalise those via the
 *  neutral enum instead.
 *
 *  This is the COMPLETE set of genuine Anthropic stop_reasons, kept so the
 *  Anthropic path is byte-for-byte what it was before the seam existed. The
 *  loop only *acts* on `tool_use` (dispatch) and `end_turn` (clean finalize);
 *  the rest (`pause_turn`/`refusal`/`stop_sequence`/`model_context_window_
 *  exceeded`) finalize the turn — unchanged from the pre-seam behavior. Loop
 *  handling of those values (e.g. resume-on-`pause_turn`) is a pre-existing
 *  orchestrator concern, deliberately out of scope for this provider-vocabulary
 *  normalization. */
const ANTHROPIC_STOP_REASONS = new Set<string>([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
]);

/** Neutral finishReason → Anthropic stop_reason. A vendor value already in the
 *  Anthropic vocabulary wins (keeps `end_turn`/`stop_sequence` distinct);
 *  anything else is normalised from the neutral enum so cross-provider tool
 *  calls reach the loop's `tool_use` dispatch. */
function toStopReason(
  finishReason: FinishReason,
  providerFinishReason: string | undefined,
): string {
  if (
    providerFinishReason !== undefined &&
    ANTHROPIC_STOP_REASONS.has(providerFinishReason)
  ) {
    return providerFinishReason;
  }
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
    default: {
      // Exhaustive over the 3-member FinishReason union. A future enum member
      // reaching here is a COMPILE error (the `never` assignment) rather than a
      // silent `undefined` stop_reason — which, being neither 'tool_use' nor
      // 'end_turn', would re-create the exact silent-finalize bug this function
      // guards against.
      const exhaustive: never = finishReason;
      throw new Error(`unhandled FinishReason: ${String(exhaustive)}`);
    }
  }
}

function fromContentPart(part: ContentPart): AnthropicBlock {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'tool_call': {
      const call = part as ToolCallPart;
      return { type: 'tool_use', id: call.id, name: call.name, input: call.input };
    }
    default:
      // image/tool_result never appear in a model RESPONSE.
      return { type: 'text', text: '' };
  }
}

/**
 * The Anthropic-shaped message the orchestrator/sub-agent loop reads back:
 * `content` blocks (text + tool_use), `stop_reason`, and snake_case `usage`.
 * Loosely typed on purpose — it feeds the loop's existing `Message = any` reads.
 */
export interface SeamMessage {
  content: AnthropicBlock[];
  stop_reason: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function fromLlmResponse(response: LlmResponse): SeamMessage {
  return {
    content: response.content.map(fromContentPart),
    stop_reason: toStopReason(
      response.finishReason,
      response.providerFinishReason,
    ),
    model: response.model,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      ...(response.usage.cacheWriteTokens !== undefined
        ? { cache_creation_input_tokens: response.usage.cacheWriteTokens }
        : {}),
      ...(response.usage.cacheReadTokens !== undefined
        ? { cache_read_input_tokens: response.usage.cacheReadTokens }
        : {}),
    },
  };
}
