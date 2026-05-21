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
   * Privacy Shield v4 — take (and clear) the server-materialized final
   * answer a `v4_render_answer` call stashed for this turn, if any.
   */
  takeRenderedAnswerV4(turnId: string): Promise<string | undefined>;
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

// ---------------------------------------------------------------------------
// Detector-Plugin-API (`privacy.detector@1`).
//
// A pluggable detector scans a string and returns hits. The capability is
// retained for add-on detector plugins (Ollama-NER, Presidio); the v4
// data-plane boundary itself is generic over JSON shape and does not
// require any detector.
// ---------------------------------------------------------------------------

/**
 * Service-registry name + capability id for a detector-registry endpoint.
 * Detector add-on plugins resolve this via
 * `ctx.services.get(PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME)`.
 */
export const PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME = 'privacyDetectorRegistry';
export const PRIVACY_DETECTOR_CAPABILITY = 'privacy.detector@1';

/**
 * Run-status emitted by a detector for a single `detect()` call.
 *
 * - `ok`: detector ran, returned its hits (possibly empty).
 * - `skipped`: detector chose not to run for an operational reason.
 * - `timeout`: detector started but hit the configured deadline.
 * - `error`: any other failure (network, broken JSON, schema-mismatch).
 */
export type PrivacyDetectorStatus = 'ok' | 'skipped' | 'timeout' | 'error';

/**
 * One PII / sensitive-content match emitted by a detector. INTERNAL —
 * `value` and `span` never leave the privacy-guard process boundary.
 */
export interface PrivacyDetectorHit {
  /** Free-form type label, e.g. `pii.email`, `pii.name`. */
  readonly type: string;
  /** Original substring matched. */
  readonly value: string;
  /** `[start, end)` offsets in the source string (UTF-16 code units). */
  readonly span: readonly [number, number];
  /** Confidence in `[0, 1]`. */
  readonly confidence: number;
  /** Detector identity emitted with this hit, e.g. `ollama:llama3.2:3b`. */
  readonly detector: string;
}

/**
 * Outcome of one `PrivacyDetector.detect()` call. Detectors MUST resolve
 * this promise — fail-open is enforced inside the detector by mapping every
 * internal failure to `{ hits: [], status: 'error' | 'timeout' | 'skipped' }`.
 */
export interface PrivacyDetectorOutcome {
  readonly hits: readonly PrivacyDetectorHit[];
  readonly status: PrivacyDetectorStatus;
  /** Optional short reason — `'input-too-long'`, `'sidecar-unreachable'`, … */
  readonly reason?: string;
}

/**
 * Per-detector scan-target filter. Default (undefined) scans everything;
 * setting a field to `false` skips that target kind.
 */
export interface PrivacyDetectorScanTargets {
  readonly systemPrompt?: boolean;
  readonly userMessages?: boolean;
  readonly assistantMessages?: boolean;
}

/**
 * A pluggable PII / sensitive-content detector.
 *
 * Contract:
 *   - `id` is stable for the detector instance lifetime.
 *   - `detect` MUST be safe to call concurrently.
 *   - The detector maps every internal failure to a non-`ok` outcome.
 */
export interface PrivacyDetector {
  readonly id: string;
  readonly scanTargets?: PrivacyDetectorScanTargets;
  detect(text: string): Promise<PrivacyDetectorOutcome>;
}

/**
 * Registry published by the privacy-guard plugin so add-on detector plugins
 * can register at activate-time.
 */
export interface PrivacyDetectorRegistry {
  /** Register a detector. Returns a dispose handle. */
  register(detector: PrivacyDetector): () => void;
  /** Snapshot of currently-registered detectors. */
  list(): readonly PrivacyDetector[];
}
