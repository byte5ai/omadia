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
 * One tool whose raw result the orchestrator passed through UNINTERNED this
 * turn — i.e. the LLM saw real values, not a `[masked]` digest — because
 * the operator set the originating plugin's `_privacy_mode` to `bypass`
 * (Slice 2.5). Surfaced in the receipt so the user sees a transparency
 * notice for every bypass decision the operator made.
 *
 * MUST stay PII-free — tool name + plugin id + count of bytes only, never
 * the raw value that crossed the boundary.
 */
export interface BypassedToolEntry {
  /** The tool name as it appears in the LLM's `tool_use` block, e.g.
   *  `confluence_get_page`. */
  readonly toolName: string;
  /** The originating plugin's agent-id (its manifest `identity.id`), e.g.
   *  `@omadia/integration-confluence`. */
  readonly pluginId: string;
  /** Why the bypass fired this turn. `operator_setting` — the operator
   *  picked `bypass` (or scoped this tool via per-tool override) on the
   *  plugin's `_privacy_mode` setting. */
  readonly reason: 'operator_setting';
  /** Byte length of the raw result that bypassed the boundary — i.e.
   *  the LLM-visible payload size. For UI transparency only. */
  readonly bytes: number;
}

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
   * Distinct personal-identity values that reached the LLM because the
   * requester named them in the request itself — e.g. typing an employee's
   * name into the chat. This is NOT a leak of tool data (the v4 boundary
   * kept that server-side); it is a transparency notice that the user
   * themselves put a real identity on the wire to the model. `0` / absent
   * when the user named no one. Derived from the Haiku schema classifier
   * (which fields are personal-identity data) intersected with the user's
   * own message — never from deny-by-default masking, so non-PII values
   * (status codes, model names) can never inflate it.
   */
  readonly identityValuesOnWire?: number;
  /**
   * Slice 2.5 — tools whose raw results bypassed the data-plane boundary
   * this turn, per the operator's per-plugin `_privacy_mode` setting.
   * Absent / empty when no bypass fired (the universal default is
   * `guarded`). PII-free: entries carry tool name + plugin id + a byte
   * count, never a raw value.
   */
  readonly bypassedTools?: readonly BypassedToolEntry[];
  /**
   * #361 — PII spans detected in the user's own prompt and substituted with
   * pseudonyms before the prompt crossed the LLM wire. Absent when prompt
   * masking is off (the default) or nothing was detected. PII-free: entries
   * carry the span TYPE + detector id only, never the value.
   */
  readonly maskedPromptSpans?: readonly PromptMaskedSpanInfo[];
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
 * Slice 2.5 — record that a tool's raw result was passed through unmasked
 * this turn because the operator set the originating plugin's
 * `_privacy_mode` to `bypass`. The entry lands in the per-turn receipt
 * verbatim — no transformation, no aggregation — so the user sees one
 * line per bypass decision.
 */
export interface PrivacyBypassedToolRequest {
  readonly turnId: string;
  readonly toolName: string;
  readonly pluginId: string;
  readonly reason: 'operator_setting';
  readonly bytes: number;
}

/**
 * A datasetId resolved back to its real rows + column schema, for a
 * server-side renderer that materializes a file the user downloads (e.g.
 * `@omadia/plugin-office`'s `create_xlsx`). The rows are REAL values — the
 * caller MUST keep them server-side and only emit a derived artifact (a file
 * the authorized user receives), never echo them onto the LLM wire. Same
 * privacy posture as `v4_render_answer`, which fills real values into the
 * user-facing answer server-side.
 */
export interface PrivacyResolvedDataset {
  /** Number of rows the dataset holds (the postcondition target). */
  readonly rowCount: number;
  /** Column schema — `path` is the row-object key, `type` the field type, `classification` (when present) marks masked vs cleartext fields. */
  readonly columns: ReadonlyArray<{
    readonly path: string;
    readonly type: string;
    readonly classification?: 'sensitive-masked' | 'safe-cleartext';
  }>;
  /** The full real rows, keyed by column `path`. */
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// #361 — free-text user-prompt PII masking (wire-substitution with
// answer-side restore).
//
// Unlike the dataset boundary (real rows never leave the server), the user's
// prompt itself must cross the wire — so detected PII spans are substituted
// with realistic pseudonyms (the shipped US7 mechanism, `v4/pseudonym.ts`),
// the surrogate-bearing text goes to the LLM, and the surrogate↔real map is
// held server-side per turn and inverted over the final answer.
// ---------------------------------------------------------------------------

/** One PII span a detector found in a prompt text. Offsets are UTF-16 code
 *  unit indices into the analyzed text; `end` is exclusive. */
export interface PromptPiiSpan {
  readonly start: number;
  readonly end: number;
  /** PII category, e.g. 'email' | 'iban' | 'phone' | 'address' | 'amount'
   *  | 'date' | 'person'. Open set — detectors may add categories. */
  readonly type: string;
  /** Detection confidence in [0,1]. The C0 regex baseline reports 1. */
  readonly confidence: number;
}

/**
 * Pluggable prompt-PII detector seam (#361). C0 is the deterministic regex
 * baseline shipped with the privacy-guard plugin; C1 is the transformer
 * ensemble slot (Piiranha / GLiNER) — wired only after the committed
 * validation harness passes its documented recall gates for a locale.
 */
export interface PromptPiiDetector {
  /** Stable id recorded (PII-free) in the receipt, e.g. 'c0-regex'. */
  readonly id: string;
  detect(text: string): Promise<readonly PromptPiiSpan[]>;
}

/** PII-free record of one masked prompt span for the receipt. */
export interface PromptMaskedSpanInfo {
  readonly type: string;
  readonly detector: string;
}

export interface PrivacyPromptMaskRequest {
  readonly sessionId: string;
  readonly turnId: string;
  /** The prompt text to mask (user message or ingested attachment tail). */
  readonly text: string;
}

/**
 * Failure-closed result contract (#361): there is NO pass-through-unmasked
 * outcome. `disabled` = the operator flag is off (caller uses the original
 * text — byte-identical legacy behavior); `masked` = surrogates substituted
 * (`degraded` when the C1 detector failed and only C0 ran, audited);
 * `blocked` = masking was requested but could not be guaranteed (baseline
 * detector failure or a residual real span survived substitution) — the
 * caller MUST fail the turn instead of sending the prompt.
 */
export type PrivacyPromptMaskResult =
  | { readonly outcome: 'disabled' }
  | {
      readonly outcome: 'masked';
      readonly maskedText: string;
      /** PII-free span records, also aggregated into the turn receipt. */
      readonly spans: readonly PromptMaskedSpanInfo[];
      readonly degraded: boolean;
    }
  | { readonly outcome: 'blocked'; readonly reason: string };

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
   * Slice 2.5 — record that the orchestrator passed a tool's raw result
   * through unmasked this turn (operator opted into `bypass` for the
   * originating plugin). The entry surfaces in the user-facing receipt
   * emitted by `finalizeTurn`. Idempotent within a turn: the orchestrator
   * may call this for every bypassed dispatch and every entry is kept.
   */
  recordBypassedTool(request: PrivacyBypassedToolRequest): Promise<void>;
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
   * Privacy Shield v4 — take (and clear) the server-materialized final
   * answer a `v4_render_answer` call stashed for this turn, if any. Carries
   * `maskedValues` — the real values rendered into the answer that the LLM
   * never saw — so channels can highlight them for the user.
   */
  takeRenderedAnswerV4(
    turnId: string,
  ): Promise<PrivacyRenderedAnswer | undefined>;
  /**
   * Privacy Shield v4 — resolve a datasetId interned earlier THIS TURN to its
   * full real rows + column schema, for a server-side renderer that
   * materializes a downloadable file (e.g. `create_xlsx`). The datasetId is an
   * opaque handle the LLM may carry; the rows it returns are REAL and MUST
   * stay server-side (the caller emits only the derived file). Returns
   * `undefined` for an unknown/expired id or after the turn was finalized.
   *
   * Optional on the interface so alternative privacy providers (and test
   * stubs) need not implement it; consumers feature-detect and degrade.
   */
  resolveDatasetForRender?(
    turnId: string,
    datasetId: string,
  ): PrivacyResolvedDataset | undefined;
  /**
   * #361 — mask PII spans in a free-text prompt before it crosses the LLM
   * wire. Gated on the plugin's default-off `mask_user_prompt` config; when
   * the flag is off the result is `{outcome:'disabled'}` and the caller
   * proceeds byte-identically to legacy behavior. Repeated calls within one
   * turn share the same server-held surrogate map (stable surrogates).
   *
   * Optional on the interface so alternative privacy providers (and test
   * stubs) need not implement it; consumers feature-detect and degrade to
   * `disabled`.
   */
  maskUserPrompt?(
    request: PrivacyPromptMaskRequest,
  ): Promise<PrivacyPromptMaskResult>;
  /**
   * #361 — invert this turn's prompt-surrogate map over a block of text
   * (the final answer), restoring real values the user originally wrote.
   * Identity when the turn masked nothing. MUST be called before
   * `finalizeTurn` — finalize drops the map.
   */
  restorePromptPseudonyms?(turnId: string, text: string): Promise<string>;
  /**
   * #361 — capture this turn's prompt-surrogate inversion as a synchronous,
   * self-contained closure (a snapshot copy of the map). For consumers that
   * complete AFTER `finalizeTurn` dropped the live map — e.g. fire-and-forget
   * fact extraction, which must restore surrogates in extracted facts to
   * real values before persisting them to the knowledge graph. Returns
   * `undefined` when the turn masked nothing (callers skip the restore pass).
   */
  snapshotPromptRestorer?(
    turnId: string,
  ): ((text: string) => string) | undefined;
  /**
   * Privacy Shield v4 — the verb + render tool specs to offer the LLM.
   */
  v4ToolSpecs(): ReadonlyArray<PrivacyV4ToolSpec>;
  /**
   * Emit the aggregated user-facing receipt for the turn and drop the
   * turn's Dataset Store. `turnInput` — the requester's own message text —
   * lets the receipt report `identityValuesOnWire`: personal-identity values
   * the user named themselves. Returns `undefined` when the turn interned no
   * tool results (nothing to report). Idempotent — a second call with the
   * same `turnId` returns `undefined`.
   */
  finalizeTurn(
    turnId: string,
    turnInput?: string,
  ): Promise<PrivacyReceipt | undefined>;
}
