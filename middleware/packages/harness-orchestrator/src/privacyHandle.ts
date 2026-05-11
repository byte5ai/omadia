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
  PrivacyGuardService,
  PrivacyOutboundMessage,
  PrivacyReceipt,
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
  };
}

// ---------------------------------------------------------------------------
// Streaming-buffered restore: holds back trailing characters that could be
// the start of a `tok_<8hex>_<type>` pattern crossing chunk boundaries.
//
// Token format (Slice 2.2, see harness-plugin-privacy-guard/src/tokenizeMap.ts):
//   `tok_` + 8 lowercase hex chars + `_` + 1..30 chars of [a-z0-9_]
//
// Strategy:
//   - Find the LAST `tok_` substring in `text`.
//   - Decide stage-by-stage whether the chars after it could still grow
//     into a complete token in a future chunk:
//       1. <8 chars and all hex            → could grow, HOLD
//       2. exactly 8 hex, no `_` yet       → could grow (`_` may follow), HOLD
//       3. 8 hex + `_`, then 0+ suffix chars and NO terminating word
//          boundary in this text yet      → could grow, HOLD
//       4. 8 hex + `_` + 1+ suffix chars + a non-[a-z0-9_] terminator
//          char already in `text`         → token complete (regex
//          will catch it on emit), no HOLD
//       5. broken pattern (non-hex in the first 8 chars, or the 9th
//          char is not `_`)               → never a token, no HOLD
//
// Trailing partial holds across chunks until either complete or definitively
// non-token. On stream end the caller flushes whatever is left as plain text.
// ---------------------------------------------------------------------------

export interface BoundarySplit {
  readonly safe: string;
  readonly hold: string;
}

export function streamingTokenBoundary(text: string): BoundarySplit {
  const lastIdx = text.lastIndexOf('tok_');
  if (lastIdx === -1) return { safe: text, hold: '' };

  const after = text.slice(lastIdx + 4);

  // Stage 1: not enough hex chars yet.
  if (after.length < 8) {
    if (/^[0-9a-f]*$/.test(after)) {
      // Could still grow into 8-hex prefix — hold.
      return { safe: text.slice(0, lastIdx), hold: text.slice(lastIdx) };
    }
    // Non-hex char already broke the pattern.
    return { safe: text, hold: '' };
  }

  // We have ≥8 chars after `tok_`. Check the first 8 are hex.
  const hexPart = after.slice(0, 8);
  if (!/^[0-9a-f]{8}$/.test(hexPart)) {
    // The first 8 chars contain a non-hex byte — definitely not a token.
    return { safe: text, hold: '' };
  }

  const sepAndSuffix = after.slice(8);

  // Stage 2: nothing after the hex yet — `_<suffix>` may still arrive.
  if (sepAndSuffix.length === 0) {
    return { safe: text.slice(0, lastIdx), hold: text.slice(lastIdx) };
  }

  // Stage 5: ninth char is not `_` — token format broken; this is plain text.
  if (sepAndSuffix[0] !== '_') {
    return { safe: text, hold: '' };
  }

  // Stage 3 / 4: have `_` separator. Look for the terminating word boundary.
  const suffix = sepAndSuffix.slice(1);
  // Search for first non-[a-z0-9_] char inside the suffix portion.
  const boundaryIdx = suffix.search(/[^a-z0-9_]/);
  if (boundaryIdx === -1) {
    // No boundary yet — suffix could still extend in the next chunk.
    return { safe: text.slice(0, lastIdx), hold: text.slice(lastIdx) };
  }
  // Boundary present in this chunk → token is fully captured; emit all and
  // let the regex restore catch it.
  return { safe: text, hold: '' };
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
