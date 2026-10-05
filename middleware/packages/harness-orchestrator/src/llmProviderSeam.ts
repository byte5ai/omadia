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
  EffortLevel,
  FinishReason,
  ImagePart,
  LlmRequest,
  LlmResponse,
  RefusalDetails,
  SystemBlock,
  TextPart,
  ToolCallPart,
  ToolChoice,
  ToolResultPart,
  ToolSpec,
} from '@omadia/llm-provider';
import { isClassRef, resolveModelRef } from '@omadia/llm-provider';

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
  /** #1033 — normalized effort the policy resolved for this turn; carried
   *  through to `LlmRequest.effort` unchanged (the adapter owns the mapping). */
  effort?: EffortLevel;
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
 * Clamp a requested output budget to the RESOLVED model's own ceiling (#1210).
 *
 * `max_tokens` arrives pre-resolved from the caller — the orchestrator plugin's
 * `orchestrator_max_tokens` (floored at the frontier class's ceiling) or the
 * host's `SUB_AGENT_MAX_TOKENS` — both sized for an always-thinking frontier
 * model, where thinking tokens count toward the budget. Sent unchanged to a
 * model with a smaller output cap — a Haiku-class model (8_192), a Mistral
 * (8_192), an operator's OpenAI-compatible or Ollama build — the vendor rejects
 * the WHOLE request with a 400 rather than silently capping it, so every turn on
 * that model fails. The floor and the clamp are not in tension: the floor raises
 * a stale config to what a frontier model needs, the clamp lowers it to what the
 * selected model accepts.
 *
 * Here because it is the chokepoint of the two paths that carry a turn's real
 * budget: `Orchestrator`'s own `complete`/`stream` calls and every local
 * sub-agent (via `streamMessageWithObserver` → `streamMessageEvents`). It is NOT
 * every sender in this package — `personaRouter`, `modelRouter` and
 * `securityScreener` hand-build an `LlmRequest` and call `provider.complete`
 * directly, bypassing this function. They need no clamp: their budgets are
 * 8–128 tokens, under every ceiling any provider publishes. A new sender that
 * carries a turn-sized budget must either route through here or clamp itself.
 *
 * `providerId` is the connection the request is about to be sent on, and it
 * matters: a bare vendor id two connected providers both serve is ambiguous
 * without it, and `resolveModelRef` falls back to ANTHROPIC for a class ref —
 * an Anthropic ceiling on a Mistral turn. Callers that know their provider pass
 * it; callers that do not get the conservative behaviour below.
 *
 * An id the registry cannot resolve passes through UNTOUCHED — the registry is
 * a curated overlay, not the universe of valid ids (an operator-typed id, a
 * fine-tune, a local build). That is the same pass-through contract
 * `resolveModelIdForProvider` uses, and it keeps the seam's behaviour unchanged
 * for hosts that register no models at all (unit tests). The known gap #1210
 * names is exactly this one: an operator-added OpenAI-compatible / Ollama /
 * MiniMax model is unclamped until its provider contributes a `maxTokens`.
 */
function clampMaxTokens(
  model: string,
  requested: number,
  providerId?: string,
): number {
  // A class ref must never reach the provider (the plugin resolves refs to a
  // concrete vendor id at build time), and resolving one WITHOUT a provider
  // hint silently yields Anthropic's model for that class. Leave it alone
  // rather than clamp to a ceiling that may belong to another vendor.
  if (providerId === undefined && isClassRef(model)) return requested;
  const ceiling = resolveModelRef(
    model,
    providerId !== undefined ? { defaultProvider: providerId } : {},
  )?.maxTokens;
  if (ceiling === undefined || ceiling <= 0) return requested;
  return Math.min(requested, ceiling);
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
  /** The provider connection this request is about to be sent on — see
   *  {@link clampMaxTokens}. Omitted only by callers that genuinely do not
   *  know it. */
  providerId?: string,
): LlmRequest {
  const system = toSystem(params.system);
  const toolChoice = toToolChoice(params.tool_choice);
  const tooling =
    params.tools !== undefined && params.tools.length > 0
      ? toToolSpecs(params.tools)
      : undefined;
  return {
    model: params.model,
    maxTokens: clampMaxTokens(params.model, params.max_tokens, providerId),
    messages: params.messages.map(toChatMessage),
    ...(system !== undefined ? { system } : {}),
    ...(tooling !== undefined ? { tools: tooling.tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(tooling?.cacheTools === true
      ? { cacheHints: { tools: true } }
      : {}),
    ...(betas !== undefined && betas.length > 0 ? { betas } : {}),
    ...(params.effort !== undefined ? { effort: params.effort } : {}),
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
  /**
   * #1219 — present only when the model's safety classifiers declined the
   * turn; `stop_reason` is then `'refusal'`. Carries the vendor's category so
   * the loops can log and report WHY, not just that it happened.
   */
  refusal?: RefusalDetails;
}

export function fromLlmResponse(response: LlmResponse): SeamMessage {
  return {
    content: response.content.map(fromContentPart),
    // A neutral `refusal` IS the refusal signal (#1219): the loops branch on
    // `stop_reason === 'refusal'`, so an adapter that reports one without the
    // Anthropic vocabulary in `providerFinishReason` must still land there.
    stop_reason:
      response.refusal !== undefined
        ? 'refusal'
        : toStopReason(response.finishReason, response.providerFinishReason),
    ...(response.refusal !== undefined ? { refusal: response.refusal } : {}),
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
