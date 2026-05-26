/**
 * Per-turn privacy-guard handle — Privacy Shield v4 Data-Plane Boundary.
 *
 * The orchestrator creates one of these at the start of a turn (when a
 * `privacy.redact@1` provider is registered) and threads it through the
 * `turnContext` AsyncLocalStorage so every tool-dispatch site in the call
 * tree — main agent or sub-agent — can grab it without an explicit param.
 *
 * The handle bakes the per-turn scoping pair `(sessionId, turnId)` plus the
 * service reference into a closure so call sites only have to pass payloads.
 */

import type {
  PrivacyGuardService,
  PrivacyReceipt,
  PrivacyRenderedAnswer,
  PrivacyV4ToolSpec,
} from '@omadia/plugin-api';

export interface PrivacyTurnHandle {
  /**
   * Intern a raw tool result server-side; returns the identity-free digest
   * text to use as the `tool_result` block content. The real rows stay
   * server-side, addressable by the `datasetId` embedded in the digest.
   */
  internToolResultV4(input: {
    readonly toolName: string;
    readonly rawResult: string;
  }): Promise<{ readonly digestText: string; readonly datasetId: string }>;
  /**
   * Run a v4 verb tool or the terminal render tool the LLM called; returns
   * the `tool_result` text.
   */
  runV4Tool(input: {
    readonly toolName: string;
    readonly input: unknown;
  }): Promise<{ readonly resultText: string }>;
  /**
   * Bridge a sub-agent's result across the data-plane boundary. Given the
   * `datasetId`s the sub-agent interned this dispatch, returns the
   * `tool_result` text for the parent agent — the sub-agent's narration plus
   * the digests of those REAL datasets — so the parent's `v4_render_answer`
   * resolves ground truth, not the sub-agent's `[masked]`-baked prose. Used
   * in place of `internToolResultV4` for a domain/sub-agent tool result.
   */
  subAgentResultV4(input: {
    readonly narration: string;
    readonly datasetIds: readonly string[];
  }): Promise<{ readonly resultText: string }>;
  /**
   * Take (and clear) the server-materialized final answer a
   * `v4_render_answer` call stashed this turn, if any — the rendered text
   * plus the `maskedValues` the LLM never saw.
   */
  takeRenderedAnswerV4(): Promise<PrivacyRenderedAnswer | undefined>;
  /** The verb + render tool specs to offer the LLM. */
  v4ToolSpecs(): ReadonlyArray<PrivacyV4ToolSpec>;
  /**
   * Drop the turn's Dataset Store and drain the user-facing receipt.
   * `turnInput` — the requester's own message text — lets the receipt
   * report identity values the user named themselves. Returns `undefined`
   * when the turn interned no tool results.
   */
  finalize(turnInput?: string): Promise<PrivacyReceipt | undefined>;
}

export function createPrivacyTurnHandle(deps: {
  readonly service: PrivacyGuardService;
  readonly sessionId: string;
  readonly turnId: string;
}): PrivacyTurnHandle {
  return {
    async internToolResultV4(input) {
      return deps.service.internToolResultV4({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        toolName: input.toolName,
        rawResult: input.rawResult,
      });
    },

    async runV4Tool(input) {
      return deps.service.runV4Tool({
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        toolName: input.toolName,
        input: input.input,
      });
    },

    async subAgentResultV4(input) {
      return deps.service.subAgentResultV4({
        turnId: deps.turnId,
        narration: input.narration,
        datasetIds: input.datasetIds,
      });
    },

    async takeRenderedAnswerV4() {
      return deps.service.takeRenderedAnswerV4(deps.turnId);
    },

    v4ToolSpecs() {
      return deps.service.v4ToolSpecs();
    },

    async finalize(turnInput) {
      return deps.service.finalizeTurn(deps.turnId, turnInput);
    },
  };
}

// ---------------------------------------------------------------------------
// Outbound surrogate hardening — last-resort guard before the API call.
//
// A JS string may legally hold a lone UTF-16 surrogate, but JSON cannot.
// The Anthropic SDK `JSON.stringify`s the request body, and the API
// rejects a lone surrogate with `400 invalid_request_error: invalid high
// surrogate in string`. Corrupt upstream data can carry one in directly —
// this guard repairs the payload so one bad character in a large tool
// result can't fail the whole turn. Orthogonal to v4 (PR #118).
// ---------------------------------------------------------------------------

const ANY_SURROGATE = /[\uD800-\uDFFF]/;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Replace every lone UTF-16 surrogate in `value` with U+FFFD. Returns a
 * value-equal string when the input is already well-formed.
 */
function toWellFormed(value: string): string {
  if (!ANY_SURROGATE.test(value)) return value;
  return value.replace(LONE_SURROGATE, '�');
}

/**
 * Deep-walk an Anthropic-API-shape `params` object and repair every
 * reachable string so the serialised request body is valid JSON.
 * Structurally shares everything that needed no change — when the whole
 * payload is well-formed the original reference is returned untouched.
 */
export function ensureWellFormedParams<T>(value: T): T {
  if (typeof value === 'string') {
    return toWellFormed(value) as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = ensureWellFormedParams(item);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const next = ensureWellFormedParams(v);
      if (next !== v) changed = true;
      out[key] = next;
    }
    return (changed ? out : value) as T;
  }
  return value;
}
