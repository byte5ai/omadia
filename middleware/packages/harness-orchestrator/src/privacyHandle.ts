/**
 * Per-turn privacy-guard handle.
 *
 * The orchestrator creates one of these at the start of `chatInContextInner`
 * (when a `privacy.redact@1` provider is registered) and threads it through
 * the `turnContext` AsyncLocalStorage so every `messages.create` /
 * `messages.stream` site in the call tree — main agent or sub-agent — can
 * grab it without an explicit param.
 *
 * The handle bakes the per-turn scoping pair `(sessionId, turnId)` plus the
 * service reference into a closure so call sites only have to pass payloads.
 *
 * Slice 2.1 surface: outbound transform + inbound restore + a `finalize()`
 * the orchestrator calls at turn end to drain the receipt.
 */

import type {
  PrivacyEgressMode,
  PrivacyEgressResult,
  PrivacyEgressTextInput,
  PrivacyGuardService,
  PrivacyOutboundMessage,
  PrivacyOutputValidationResult,
  PrivacyPostEgressScrubResult,
  PrivacyReceipt,
  PrivacySelfAnonymizationResult,
  Routing,
} from '@omadia/plugin-api';

export interface PrivacyTurnHandle {
  /**
   * Tokenise an outbound LLM payload. Idempotent within the per-session
   * map: re-running with the same payload produces the same tokens.
   */
  processOutbound(input: {
    readonly systemPrompt: string;
    readonly messages: ReadonlyArray<PrivacyOutboundMessage>;
  }): Promise<{
    readonly systemPrompt: string;
    readonly messages: ReadonlyArray<PrivacyOutboundMessage>;
    readonly routing: Routing;
  }>;
  /**
   * Restore tokens to original values in an inbound text fragment.
   * Streaming callers MUST also apply their own buffered-lookahead for
   * partial tokens spanning chunk boundaries — see
   * `streamingTokenBoundary` in `./streaming.ts`.
   */
  processInbound(text: string): Promise<string>;
  /**
   * Drain the per-turn detection accumulator into a single PII-free
   * receipt. Returns `undefined` when no outbound was ever processed
   * for this turn (e.g. the privacy provider booted mid-turn).
   * Idempotent — second call returns `undefined`.
   */
  finalize(): Promise<PrivacyReceipt | undefined>;
  /**
   * Slice 2.2 — restore tokens in a tool-call's input arguments before
   * the orchestrator dispatches the handler. The proxy walks the input
   * tree recursively; every string field has `tok_<hex>` substrings
   * replaced by the original value bound in the session map. Returns
   * the rebuilt input + a count of restored tokens for telemetry.
   */
  processToolInput(input: { readonly toolName: string; readonly input: unknown }): Promise<{
    readonly input: unknown;
    readonly tokensRestored: number;
  }>;
  /**
   * Slice 2.2 — re-tokenise PII in a tool-call's text result before it
   * goes back to the LLM as a `tool_result` block. Runs the same
   * detector pipeline as `processOutbound`; hits land in the same
   * turn-accumulator so the receipt aggregates them with everything
   * else.
   */
  processToolResult(input: { readonly toolName: string; readonly text: string }): Promise<{
    readonly text: string;
    readonly transformed: boolean;
  }>;
  /**
   * Privacy-Shield v2 (Slice S-6) — run the Egress Filter against the
   * final channel-bound text slots before the answer is handed to the
   * channel plugin. The host walks the result-shape (text + interactive
   * card labels + attachment alt-text) and hands each slot in as a
   * `{ id, text }` pair; the filter returns a transformed array plus
   * the routing decision the host MUST honour (`blocked` → swap with
   * placeholder).
   */
  egressFilter(input: {
    readonly mode?: PrivacyEgressMode;
    readonly texts: readonly PrivacyEgressTextInput[];
  }): Promise<PrivacyEgressResult>;
  /**
   * Privacy-Shield v2 (D-2) — Output Validator hook. Runs the
   * token-loss + spontaneous-PII checks on the final assistant text
   * BEFORE the egress filter so the orchestrator can act on the
   * `retry` / `block` recommendation. Result is folded into the
   * receipt's `output` block at `finalize()` time.
   */
  validateOutput(input: {
    readonly assistantText: string;
  }): Promise<PrivacyOutputValidationResult>;
  /**
   * Privacy-Shield v2 (Phase A, post-deploy 2026-05-14) — mechanical
   * restoration of LLM self-anonymization patterns ("Mitarbeiter 1/2/3",
   * "Employee N", "Person N", …). Runs after `processInbound` has
   * restored the verbatim tokens, before the egress filter. The
   * positional source comes from the last `processToolResult` capture
   * (tracked on the service's turn accumulator).
   */
  restoreSelfAnonymizationLabels(input: {
    readonly text: string;
  }): Promise<PrivacySelfAnonymizationResult>;
  /**
   * Privacy-Shield v2 (Phase A.2) — final-scrub pass post-egress.
   * Guarantees the returned text contains no `«TYPE_N»` token shapes
   * via positional restoration + generic placeholder fallback.
   */
  restoreOrScrubRemainingTokens(input: {
    readonly text: string;
  }): Promise<PrivacyPostEgressScrubResult>;
}

export function createPrivacyTurnHandle(deps: {
  readonly service: PrivacyGuardService;
  readonly sessionId: string;
  readonly turnId: string;
  readonly agentId?: string;
}): PrivacyTurnHandle {
  return {
    async processOutbound(input) {
      const result = await deps.service.processOutbound({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        ...(deps.agentId !== undefined ? { agentId: deps.agentId } : {}),
        systemPrompt: input.systemPrompt,
        messages: input.messages,
      });
      return {
        systemPrompt: result.systemPrompt,
        messages: result.messages,
        routing: result.routing,
      };
    },

    async processInbound(text) {
      const r = await deps.service.processInbound({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        text,
      });
      return r.text;
    },

    async finalize() {
      return deps.service.finalizeTurn(deps.turnId);
    },

    async processToolInput(input) {
      const r = await deps.service.processToolInput({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        toolName: input.toolName,
        input: input.input,
      });
      return { input: r.input, tokensRestored: r.tokensRestored };
    },

    async processToolResult(input) {
      const r = await deps.service.processToolResult({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        toolName: input.toolName,
        text: input.text,
      });
      return { text: r.text, transformed: r.transformed };
    },

    async egressFilter(input) {
      return deps.service.egressFilter({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        texts: input.texts,
      });
    },

    async validateOutput(input) {
      return deps.service.validateOutput({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        assistantText: input.assistantText,
      });
    },

    async restoreSelfAnonymizationLabels(input) {
      return deps.service.restoreSelfAnonymizationLabels({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        text: input.text,
      });
    },

    async restoreOrScrubRemainingTokens(input) {
      return deps.service.restoreOrScrubRemainingTokens({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        text: input.text,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming-buffered restore: holds back trailing characters that could be
// the start of a `«TYPE_N»` token pattern crossing chunk boundaries.
//
// Token format (Privacy-Shield v2, see harness-plugin-privacy-guard/src/tokenizeMap.ts):
//   `«` + uppercase TYPE + `_` + counter + `»`
//
// The closing guillemet `»` is the unambiguous terminator. We hold from
// the last `«` until either:
//   - a `»` arrives in this chunk → token is complete, emit all
//   - or the chunk ends → keep holding for the next chunk
//
// False holds (a stray `«` that never closes, e.g. legitimate use of
// guillemets in prose) flush when the chunk ends or another `«` appears.
// On stream end the caller flushes whatever is left as plain text.
// ---------------------------------------------------------------------------

export interface BoundarySplit {
  readonly safe: string;
  readonly hold: string;
}

export function streamingTokenBoundary(text: string): BoundarySplit {
  const lastOpen = text.lastIndexOf('«');
  if (lastOpen === -1) return { safe: text, hold: '' };

  // If the last `«` is followed by a closing `»` somewhere later in
  // this chunk, the token (or false-positive) is fully captured here.
  // Emit everything and let the restore regex decide.
  const after = text.slice(lastOpen);
  if (after.includes('»')) return { safe: text, hold: '' };

  // No closing guillemet yet — the token may complete in the next
  // chunk. Hold from the opening guillemet.
  return { safe: text.slice(0, lastOpen), hold: text.slice(lastOpen) };
}

// ---------------------------------------------------------------------------
// Anthropic-API-shape outbound transform + inbound restore. Used by both
// `streamMessageEvents` (streaming path) and the orchestrator's direct
// `messages.create` call site so the same wrap logic covers both paths.
// ---------------------------------------------------------------------------

/**
 * Tokenise the system block + every string-content message in an
 * Anthropic-API-shape `params` object. Multi-block content (image
 * attachments, tool_result arrays) passes through unchanged for now —
 * Slice 2.2 extends the walk to cover tool-call args + tool-result
 * content. Throws when the routing decision is `blocked`.
 */
export async function applyPrivacyOutboundToParams(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  privacy: PrivacyTurnHandle,
  callLabel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const systemPrompt = extractSystemString(params.system);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: ReadonlyArray<any> = Array.isArray(params.messages)
    ? params.messages
    : [];

  const guardInput = messages.map((m) => ({
    role: normaliseRole(m?.role),
    content: typeof m?.content === 'string' ? m.content : '',
  }));

  let outboundResult;
  try {
    outboundResult = await privacy.processOutbound({
      systemPrompt,
      messages: guardInput,
    });
  } catch (err) {
    console.warn(
      `[${callLabel}] privacyGuard.processOutbound threw — proceeding with original payload:`,
      err,
    );
    return params;
  }

  if (outboundResult.routing === 'blocked') {
    throw new Error(
      '[privacy] outbound blocked by privacy.redact@1 policy — request not sent.',
    );
  }

   
  const newMessages = messages.map((m, i) => {
    if (typeof m?.content !== 'string') return m;
    const transformed = outboundResult.messages[i]?.content;
    if (transformed === undefined || transformed === m.content) return m;
    return { ...m, content: transformed };
  });

  const newSystem = injectSystemString(params.system, outboundResult.systemPrompt);

  return { ...params, system: newSystem, messages: newMessages };
}

/**
 * Walk an Anthropic-API-shape response message and restore tokens in
 * every `text` content block. Mutates in place. Safe to call when the
 * response shape lacks `content`.
 */
export async function restorePrivacyInResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  privacy: PrivacyTurnHandle,
): Promise<void> {
  if (!response || !Array.isArray(response.content)) return;
  for (const block of response.content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      block.text = await privacy.processInbound(block.text);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSystemString(system: any): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectSystemString(originalSystem: any, transformed: string): any {
  if (typeof originalSystem === 'string') return transformed;
  // Array-shaped system: leave structure intact for now (cache-shape
  // contract is sensitive). Slice 2.2 handles per-block rewrite.
  return originalSystem;
}

function normaliseRole(r: unknown): 'user' | 'assistant' | 'system' {
  return r === 'assistant' ? 'assistant' : r === 'system' ? 'system' : 'user';
}
