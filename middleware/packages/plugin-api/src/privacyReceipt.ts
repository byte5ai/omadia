/**
 * `privacy.redact@1` — capability contract for the Privacy Shield v4
 * Data-Plane Boundary.
 *
 * v4 inverts the privacy model: a raw tool result is never serialized into
 * an LLM-bound message. It is interned server-side behind a `datasetId`;
 * the LLM receives only an identity-free Digest. Identity-/order-critical
 * work runs in trusted server code via the Verb API, and the final answer
 * is materialized server-side from ground truth.
 *
 * The `PrivacyReceipt` is the per-turn user-facing report, re-expressed in
 * v4 terms — datasets interned, fields masked/cleartext per classification,
 * verbs executed. PII-free by construction (counts only).
 */

export const PRIVACY_REDACT_SERVICE_NAME = 'privacyRedact';
export const PRIVACY_REDACT_CAPABILITY = 'privacy.redact@1';

/**
 * The per-turn user-facing privacy report. Emitted by `finalizeTurn` and
 * attached to the assistant message metadata; channel renderers (Teams
 * card, Web disclosure) consume it to build their collapsible UI.
 *
 * MUST stay PII-free — counts and verb names only, never a value.
 */
export interface PrivacyReceipt {
  /** Tool results interned behind the data-plane boundary this turn. */
  readonly datasetsInterned: number;
  /** Fields classified `sensitive-masked` across interned datasets. */
  readonly fieldsMasked: number;
  /** Fields classified `safe-cleartext` across interned datasets. */
  readonly fieldsCleartext: number;
  /** Verb names the LLM composed and the server executed this turn. */
  readonly verbsExecuted: readonly string[];
  /** Whether the gated pseudonym-projection layer was released this turn. */
  readonly pseudonymProjectionUsed: boolean;
  /**
   * Distinct identity values that reached the LLM wire because the requester
   * named them in the request itself (a name typed into the chat). The turn
   * is NOT blocked for these — the user already knows the value — but it is
   * surfaced as a soft breach so the disclosure stays honest: yes, a real
   * name was on the wire this turn. `0` (or absent) when the user named
   * nobody. A masked value the user did NOT provide that reaches the wire is
   * a *hard* breach — the turn fails closed and emits no receipt at all.
   */
  readonly identityValuesOnWire?: number;
}

// ---------------------------------------------------------------------------
// Privacy Shield v4 — Data-Plane Boundary service surface.
//
// The orchestrator drives the service through the tool-dispatch seam:
//   1. `internToolResultV4` once per raw tool result — interns the rows
//      server-side, returns the identity-free Digest text.
//   2. `runV4Tool` for every `v4_*` tool call the LLM composes — runs the
//      verb / render directive in trusted server code.
//   3. `takeRenderedAnswerV4` at turn end — drains a server-materialized
//      final answer, if a `v4_render_answer` call produced one.
//   4. `finalizeTurn` once at turn end — drops the turn's datasets and
//      emits the user-facing receipt.
// ---------------------------------------------------------------------------

export interface PrivacyToolResultV4Request {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolName: string;
  /** The tool's raw text result as the handler returned it. */
  readonly rawResult: string;
}

export interface PrivacyToolResultV4Result {
  /** The identity-free digest text to use verbatim as the `tool_result`
   *  block content. The raw rows stay server-side, addressable by the
   *  `datasetId` embedded in this text. */
  readonly digestText: string;
  /** The `datasetId` the raw rows were interned behind — also embedded in
   *  `digestText`, surfaced here so a caller (e.g. a sub-agent tracking the
   *  datasets it produced) need not parse the digest JSON. */
  readonly datasetId: string;
}

/**
 * Privacy Shield v4 — sub-agent data-plane bridge.
 *
 * A domain tool wraps a sub-agent that runs its own LLM loop behind the SAME
 * v4 boundary: every tool result it fetches is interned, so its LLM only ever
 * sees `[masked]` and the prose answer it returns has `[masked]` baked in.
 * Re-interning that prose as a fresh dataset would lose the real values for
 * good. Instead the orchestrator tracks the `datasetId`s the sub-agent
 * interned and passes them — by reference — to `subAgentResultV4`, which
 * re-surfaces the digests of those REAL datasets to the parent agent so its
 * `v4_render_answer` resolves ground truth.
 */
export interface PrivacySubAgentResultV4Request {
  readonly turnId: string;
  /** The sub-agent's own narration — LLM prose. Already PII-free: the
   *  sub-agent only ever saw masked digests. Passed through as context. */
  readonly narration: string;
  /** The `datasetId`s the sub-agent interned this dispatch, in intern
   *  order. Each still lives in the turn's Dataset Store with real rows. */
  readonly datasetIds: readonly string[];
}

export interface PrivacyV4ToolRequest {
  readonly sessionId: string;
  readonly turnId: string;
  /** The `v4_*` tool name the LLM called. */
  readonly toolName: string;
  /** The unparsed tool input as received from the LLM. */
  readonly input: unknown;
}

/** An Anthropic-tool-shaped spec for a v4 verb / render tool. */
export interface PrivacyV4ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/** The server-materialized final answer produced by a `v4_render_answer` call. */
export interface PrivacyRenderedAnswer {
  /** The rendered, channel-bound answer body (real values). */
  readonly text: string;
  /**
   * Distinct real values rendered into `text` from `sensitive-masked`
   * columns — exactly the values the LLM never saw. Channels MAY highlight
   * their occurrences so the user sees what the server resolved behind the
   * boundary. Empty when the rendered answer exposed no masked field.
   */
  readonly maskedValues: readonly string[];
}

/**
 * Service surface published by the `privacy.redact@1` provider plugin.
 */
export interface PrivacyGuardService {
  /**
   * Privacy Shield v4 — intern a raw tool result server-side behind a
   * `datasetId` and return the identity-free digest text to use as the
   * `tool_result` block content. The real rows never reach the LLM wire.
   */
  internToolResultV4(
    request: PrivacyToolResultV4Request,
  ): Promise<PrivacyToolResultV4Result>;
  /**
   * Privacy Shield v4 — run a v4 verb tool or the terminal render tool the
   * LLM called. Returns the text to place in the `tool_result` block. A
   * `v4_render_answer` call materializes the answer server-side and stashes
   * it (drained via `takeRenderedAnswerV4`).
   */
  runV4Tool(request: PrivacyV4ToolRequest): Promise<{ readonly resultText: string }>;
  /**
   * Privacy Shield v4 — bridge a sub-agent's result across the data-plane
   * boundary. Given the `datasetId`s the sub-agent interned, returns the
   * `tool_result` text for the parent agent: the sub-agent's narration plus
   * the digests of those REAL datasets (still server-side, addressable by
   * id) — so the parent's `v4_render_answer` resolves ground truth instead
   * of the sub-agent's `[masked]`-baked prose. Used in place of
   * `internToolResultV4` for a domain/sub-agent tool result.
   */
  subAgentResultV4(
    request: PrivacySubAgentResultV4Request,
  ): Promise<{ readonly resultText: string }>;
  /**
   * Privacy Shield v4 — runtime on-the-wire guard. Scans an LLM-bound
   * payload (the `messages.create` / `messages.stream` params) for any
   * `sensitive-masked` identity value interned this turn and throws,
   * fail-closed, if one is present. Only the data-plane surfaces are
   * scanned — `tool_result` blocks and assistant content — never the
   * human's own typed text or the static system prompt, so a name the
   * user volunteered is not a false positive. A no-op when the turn
   * interned nothing. Call at the API-call seam, just before dispatch.
   */
  assertWireCleanV4(turnId: string, payload: unknown): void;
  /**
   * Privacy Shield v4 — take (and clear) the server-materialized final
   * answer a `v4_render_answer` call stashed for this turn, if any. Carries
   * `maskedValues` — the real values rendered into the answer that the LLM
   * never saw — so channels can highlight them for the user.
   */
  takeRenderedAnswerV4(
    turnId: string,
  ): Promise<PrivacyRenderedAnswer | undefined>;
  /**
   * Privacy Shield v4 — the verb + render tool specs to offer the LLM.
   */
  v4ToolSpecs(): ReadonlyArray<PrivacyV4ToolSpec>;
  /**
   * Emit the aggregated user-facing receipt for the turn and drop the
   * turn's Dataset Store. Returns `undefined` when the turn interned no
   * tool results (nothing to report). Idempotent — a second call with the
   * same `turnId` returns `undefined`.
   */
  finalizeTurn(turnId: string): Promise<PrivacyReceipt | undefined>;
}
