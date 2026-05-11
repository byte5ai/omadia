/**
 * `privacy.redact@1` — capability contract for the privacy proxy that
 * intercepts outbound LLM payloads, redacts/tokenizes PII, and emits a
 * user-facing PrivacyReceipt summarising what was done.
 *
 * Slice 1a (this file): the shared type vocabulary. Lets the UI renderer
 * (Slice 5) build against fixtures while Slice 1b implements the wrapper
 * + Presidio detector + tokenize-map roundtrip.
 *
 * The receipt itself is deliberately PII-free — no spans, no offsets,
 * no original values, no tokenisation map. Only counts, types, and
 * detector metadata. That property is what makes it safe to render
 * inline in a Teams card or Web disclosure without hollowing out the
 * privacy guarantee.
 */

export const PRIVACY_REDACT_SERVICE_NAME = 'privacyRedact';
export const PRIVACY_REDACT_CAPABILITY = 'privacy.redact@1';

/**
 * Policy mode determines how strict the proxy is.
 *
 * - `pii-shield` (default): PII is tokenised/redacted but the request
 *   still goes to the public LLM. General-purpose protection.
 * - `data-residency`: tenant-labelled fields (`customer_data`,
 *   `confidentiality:internal`) hard-block the public LLM and route
 *   to a local Ollama sidecar. For B2B contracts requiring data
 *   residency.
 */
export type PolicyMode = 'pii-shield' | 'data-residency';

/**
 * Where the request was actually sent after policy resolution.
 *
 * - `public-llm`: routed to the configured public provider (Anthropic / OpenAI / …).
 * - `local-llm`: routed to a tenant-local LLM sidecar (data-residency mode).
 * - `blocked`: request was rejected entirely; nothing was sent.
 */
export type Routing = 'public-llm' | 'local-llm' | 'blocked';

/**
 * What the proxy did with a specific detection.
 *
 * - `redacted`: replaced with a non-recoverable placeholder. Original is gone.
 * - `tokenized`: replaced with an opaque reversible token; restored on the
 *   inbound path so the user sees real values in the final answer.
 * - `blocked`: detection caused the entire request to be aborted (in
 *   data-residency mode with a strict label).
 * - `passed`: detection emitted by the detector but policy decided to let
 *   it through unchanged (e.g. low-risk type with `pass` action).
 */
export type DetectionAction = 'redacted' | 'tokenized' | 'blocked' | 'passed';

export interface PrivacyDetection {
  /** Detection type label, e.g. `pii.email`, `pii.iban`, `custom.contract_id`.
   *  Free-form so per-tenant custom labels are supported without a schema
   *  change. The UI renderer maps known prefixes (`pii.*`) to localised
   *  human labels and falls back to the raw type for unknowns. */
  readonly type: string;
  /** How many instances of this type were detected in the payload. */
  readonly count: number;
  /** The action the policy engine applied to all instances of this type
   *  in this turn. If different instances need different actions, the
   *  detector emits multiple `PrivacyDetection` entries with the same
   *  `type` and different `action` values. */
  readonly action: DetectionAction;
  /** Detector identity + version, e.g. `presidio:2.2.351`,
   *  `ollama:llama3.2:3b`. Surfaced so the user can verify which
   *  engine made the call. */
  readonly detector: string;
  /** Worst-case (lowest) detector confidence across all instances of this
   *  type in this turn. Range `[0, 1]`. The UI may flag low-confidence
   *  detections in expanded view. */
  readonly confidenceMin: number;
  /**
   * OPTIONAL — distinct raw values matched in this (type, action, detector)
   * bucket. ONLY populated when the privacy-guard plugin is configured with
   * `debug_show_values=on` (Slice 3.2.1 operator-toggle, default off).
   *
   * Undefined in production receipts so the PII-free contract holds. When
   * present, the receipt itself becomes a PII carrier and the operator is
   * responsible for downstream protection (no append to logs, no export
   * outside the dev tenant, etc).
   *
   * Only `tokenized` actions emit values — `redacted` / `blocked` are
   * intentionally destructive and the value is not retained even in
   * debug mode.
   */
  readonly values?: readonly string[];
}

/**
 * The user-facing privacy receipt for a single LLM turn. Emitted by the
 * `privacy.redact@1` capability and attached to the assistant message
 * metadata. Channel renderers (Teams card, Web disclosure) consume this
 * to build their collapsible UI.
 *
 * MUST stay PII-free. If you find yourself wanting to add a span, an
 * offset, or a token-map preview to this type, stop and add it to the
 * audit pipeline (Slice 4) instead.
 */
export interface PrivacyReceipt {
  /** Stable id, surfaced to the user as a copyable reference for support
   *  tickets and Audit-Report-Export lookups. Format
   *  `prv_<yyyy-mm-dd>_<random>`. */
  readonly receiptId: string;
  readonly policyMode: PolicyMode;
  readonly routing: Routing;
  /** Human-readable routing reason; rendered in the expanded card.
   *  Examples: `"tenant label customer_data"`, `"detector unavailable"`,
   *  `"strict policy: api-key detected"`. Optional — `pii-shield` flows
   *  often have nothing interesting to show here. */
  readonly routingReason?: string;
  /** What the detector found, grouped by type+action. May be empty when
   *  nothing was detected (the receipt is still emitted so the user sees
   *  "Privacy Guard active · 0 detections" rather than silent absence). */
  readonly detections: readonly PrivacyDetection[];
  /** Wall-clock latency for the detector + policy step in milliseconds.
   *  Excludes the public-LLM round-trip. */
  readonly latencyMs: number;
  /** SHA-256 (hex) of the canonicalised original payload. PII-free in
   *  isolation; only useful as a forensic correlation key against the
   *  audit pipeline. The user sees the prefix only ("a3f9…"). */
  readonly auditHash: string;
  /**
   * Slice 3.2.1: per-detector run summary aggregated across every
   * outbound call in the turn. Surfaces `skipped` / `timeout` / `error`
   * cases that would otherwise look identical to "0 hits" in the UI.
   *
   * Always present (may be empty if no detector ran at all). The UI
   * uses the run statuses to bump severity into amber/orange when a
   * detector silently fail-opens, so the user sees a clear "detector
   * ausgelassen" signal instead of false-confidence "keine Erkennungen".
   */
  readonly detectorRuns: readonly PrivacyDetectorRun[];
  /**
   * Slice 3.2.1 debug flag — `true` iff the operator enabled
   * `debug_show_values=on` and the receipt may carry `values` arrays
   * inside `detections`. Channel renderers use this to surface a
   * prominent "DEBUG-MODUS" badge so a screenshot or export never
   * looks like a production receipt.
   */
  readonly debug?: boolean;
  /**
   * Slice 2.2 — tool-roundtrip telemetry. Aggregated counters across
   * every `processToolInput` / `processToolResult` call within the
   * turn. Helps the operator verify the roundtrip actually fired —
   * a turn with `tools=N` in the chat-trace should typically see
   * `argsRestored>0` (tokens went IN to handlers) and
   * `resultsTokenized>0` (handler results came OUT through the
   * detectors). Absent when no tool roundtrip ran in the turn.
   */
  readonly toolRoundtrip?: {
    /** Sum of tokens restored across all tool-input invocations. */
    readonly argsRestored: number;
    /** Number of tool-result strings that were transformed (had ≥1 hit). */
    readonly resultsTokenized: number;
    /** Total tool roundtrip calls made (input+result counted separately). */
    readonly callCount: number;
  };
}

// ---------------------------------------------------------------------------
// Slice 3.2.1 — Detector-run transparency.
//
// The `PrivacyDetector` contract from 3.1 returned hits[] only — which
// made `0 hits` indistinguishable from `detector skipped` or `chat
// timeout`. 3.2.1 widens the return type so the host can surface those
// states explicitly in the receipt.
// ---------------------------------------------------------------------------

/**
 * Run-status emitted by a detector for a single `detect()` call.
 *
 * - `ok`: detector ran, returned its hits (possibly empty). The `[]`
 *   case is a real "I scanned, found nothing" answer.
 * - `skipped`: detector chose not to run for an operational reason
 *   (input too long, feature flag off, …). NOT an error — the receipt
 *   should explain the skip.
 * - `timeout`: detector started but hit the configured deadline. Hits
 *   are empty by definition; the upstream may want to retry or alert.
 * - `error`: any other failure (network, broken JSON, schema-mismatch).
 *   Hits are empty.
 */
export type PrivacyDetectorStatus = 'ok' | 'skipped' | 'timeout' | 'error';

/**
 * Outcome of one `PrivacyDetector.detect()` call. Replaces the
 * Slice-3.1 `Promise<readonly PrivacyDetectorHit[]>` return so the
 * detector can signal `skipped` / `timeout` / `error` distinctly from
 * "0 hits".
 *
 * Detectors MUST resolve this promise — fail-open is enforced inside
 * the detector by mapping every internal failure to
 * `{ hits: [], status: 'error' | 'timeout' | 'skipped', reason }`.
 * A thrown exception is caught by the privacy-guard service and
 * surfaced as `{ hits: [], status: 'error', reason: <message> }`.
 */
export interface PrivacyDetectorOutcome {
  readonly hits: readonly PrivacyDetectorHit[];
  readonly status: PrivacyDetectorStatus;
  /**
   * Optional short reason — `'input-too-long'`, `'sidecar-unreachable'`,
   *  `'broken-json'`, etc. Free-form `string` because new detectors
   *  invent their own reasons; the UI shows it verbatim and the receipt
   *  layer doesn't interpret. Truncated to a small budget (~80 chars)
   *  before crossing the receipt boundary so a noisy stack-trace can't
   *  blow up the receipt size.
   */
  readonly reason?: string;
}

/**
 * Per-turn aggregated run summary for one detector. Every detector
 * registered with the privacy-guard service contributes exactly one
 * `PrivacyDetectorRun` to the receipt — even if it ran zero times in
 * this turn (e.g. the input was always too long), so the operator sees
 * the full active-detector list in every receipt.
 */
export interface PrivacyDetectorRun {
  /** Detector identity, e.g. `regex:0.1.0`, `ollama:llama3.2:3b`. */
  readonly detector: string;
  /** Worst status across every `detect()` call this detector made in
   *  the turn. Severity order: error > timeout > skipped > ok. */
  readonly status: PrivacyDetectorStatus;
  /** How many `detect()` calls this detector made (one per outbound
   *  payload — main + sub-agents). */
  readonly callCount: number;
  /** How many hits this detector contributed to the receipt's
   *  `detections` aggregate (after span-overlap dedup, so a hit dropped
   *  by another detector winning the dedup is NOT counted here). */
  readonly hitCount: number;
  /** Sum of detector latency across all calls, in ms. */
  readonly latencyMs: number;
  /** Reason for the worst status, if any (`reason` field of the
   *  worst-status outcome). Helps the operator understand WHY a
   *  detector skipped or errored. */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Service surface (Slice 2.1: end-to-end roundtrip).
//
// The orchestrator drives the service in three phases per turn:
//   1. `processOutbound` once per LLM call (main path + each sub-agent
//      iteration). Returns a tokenised payload + routing decision.
//   2. `processInbound` for every assistant text fragment (one shot for
//      non-streaming responses, many calls for streaming text_deltas).
//      Restores tokens to original values so the user sees real data.
//   3. `finalizeTurn` once at turn-end. Aggregates the detections from
//      every `processOutbound` call into a single user-facing receipt.
//
// Token-replacement is stateless from the host's perspective — all
// per-session bookkeeping (token map, accumulator) lives inside the
// provider, keyed by `(sessionId, turnId)`.
// ---------------------------------------------------------------------------

/**
 * One outbound message as the orchestrator hands it to the privacy guard.
 *
 * Content is restricted to `string` for Slice 2.1 — multimodal content
 * (image blocks etc.) is passed through unchanged by the orchestrator and
 * not surfaced here. Slice 2.2 expands this to tool-call args + tool-
 * result content; the message shape itself stays string-based.
 */
export interface PrivacyOutboundMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
}

export interface PrivacyOutboundRequest {
  /** Stable id for the chat session — used to scope the tokenise-map so
   *  the same value yields the same token across multiple turns of one
   *  conversation. Required from Slice 2.1; Slice 1b's per-turn map is
   *  superseded. */
  readonly sessionId: string;
  /** Stable id for the in-flight orchestrator turn — used to scope the
   *  receipt accumulator. Multiple `processOutbound` calls with the same
   *  `turnId` (main agent + N sub-agents) aggregate into ONE receipt at
   *  `finalizeTurn`. */
  readonly turnId: string;
  /** Optional active agent id, mirrors the responseGuard hook so the
   *  policy engine can apply per-agent overrides without a separate
   *  resolver. */
  readonly agentId?: string;
  /** System prompt the orchestrator built (after responseGuard splice).
   *  The provider scans + transforms it identically to user messages. */
  readonly systemPrompt: string;
  /** Recent turn history + the in-flight user message. */
  readonly messages: ReadonlyArray<PrivacyOutboundMessage>;
}

export interface PrivacyOutboundResult {
  /** System prompt with detections applied (redacted/tokenised). When the
   *  detector finds nothing this is byte-identical to the input so the
   *  prompt-cache key is preserved. */
  readonly systemPrompt: string;
  /** Messages with detections applied, in the same order as the input.
   *  Same byte-identity property as `systemPrompt` for empty-detection
   *  turns. */
  readonly messages: ReadonlyArray<PrivacyOutboundMessage>;
  /** Routing decision the host MUST honour:
   *   - `public-llm`: proceed with the configured public LLM call
   *   - `local-llm`:  reroute to a tenant-local sidecar (Slice 3)
   *   - `blocked`:    abort this LLM call; the host either falls back
   *                   gracefully or surfaces a refusal to the user.
   *  Slice 2.1 providers only emit `public-llm` or `blocked`. */
  readonly routing: Routing;
}

export interface PrivacyInboundRequest {
  /** Same scoping pair as the outbound — needed so the provider can find
   *  the per-session tokenise-map for the restore. */
  readonly sessionId: string;
  readonly turnId: string;
  /** A fragment of assistant-generated text. May be a full response (non-
   *  streaming) or a single `text_delta` chunk (streaming). The provider
   *  treats it as opaque and replaces every token-shaped substring it
   *  recognises with the original value. Tokens that aren't in the map
   *  are left as-is (Slice 2.3 will flag these as hallucinations). */
  readonly text: string;
}

export interface PrivacyInboundResult {
  /** Restored text with all known tokens substituted back. Streaming
   *  callers MUST also apply their own buffered-restore for partial
   *  patterns crossing chunk boundaries — the provider replaces only
   *  whole-token matches. */
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Slice 2.2 — Tool-roundtrip surface.
//
// Why we need this: Slice 2.1 tokenises PII before it reaches the public
// LLM. The LLM then emits `tool_use` blocks whose `input` arguments may
// reference those tokens (e.g. `{ name: "tok_a3f9" }` for a query against
// Odoo). If we hand that tokenised input to the actual tool handler, the
// handler queries Odoo for "tok_a3f9" and finds nothing — the tool fails
// even though the user's question was perfectly resolvable.
//
// And the symmetric direction: a tool result string returned to the LLM
// as `tool_result` content may carry fresh PII (Odoo returns "Marcel
// Wege"). Without re-tokenisation, that plaintext flows back to the
// public LLM in the next iteration of the tool-loop — defeating the
// privacy guarantee.
//
// Slice 2.2 closes both gaps with a deterministic roundtrip:
//
//   tool_use input  ──▶ processToolInput  ──▶ handler(restored) ──▶ result
//   handler result  ──▶ processToolResult ──▶ tool_result block back to LLM
//
// Both sides fold their detector runs / token activity into the SAME
// turn-accumulator as `processOutbound`, so the user-facing receipt
// covers the full turn including tool roundtrips.
// ---------------------------------------------------------------------------

export interface PrivacyToolInputRequest {
  readonly sessionId: string;
  readonly turnId: string;
  /** Tool name as emitted in the `tool_use` block. Surfaced for telemetry. */
  readonly toolName: string;
  /** The unparsed tool-use input as received from the LLM. Walked
   *  recursively; every string field is scanned for `tok_<hex>`
   *  substrings and restored against the session's tokenise-map.
   *  Non-string fields (numbers, booleans, nested objects, arrays)
   *  pass through unchanged. */
  readonly input: unknown;
}

export interface PrivacyToolInputResult {
  /** Same shape as input, with `tok_<hex>` substrings replaced by the
   *  bound original values. Tokens unknown to the session map are left
   *  in place (Slice 2.3 will surface those as hallucinations). */
  readonly input: unknown;
  /** How many string fields had at least one token restored. Surfaced
   *  on the receipt as a `toolRoundtrip.argsRestored` counter so the
   *  operator can verify the roundtrip actually fired. */
  readonly tokensRestored: number;
}

export interface PrivacyToolResultRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolName: string;
  /** Tool's text result as the handler returned it. The provider runs
   *  the same detector pipeline as `processOutbound` over this text,
   *  applies the policy decisions (tokenize / redact / pass / block),
   *  and returns the transformed string. Hits land in the SAME turn
   *  accumulator so the receipt aggregates them with everything else. */
  readonly text: string;
}

export interface PrivacyToolResultResult {
  /** Tool result with detected PII tokenised / redacted per policy.
   *  Safe to drop into the next outbound `tool_result` content block
   *  without re-running `processOutbound`. */
  readonly text: string;
  /** Whether anything in the result was transformed. `false` means
   *  byte-identical pass-through (no detector hits). */
  readonly transformed: boolean;
}

/**
 * Service surface published by a `privacy.redact@1` provider plugin.
 *
 * Async by contract because Slice 3's local-LLM detector will await an
 * Ollama call. The Slice 2.1 regex provider resolves synchronously and
 * just wraps in `Promise.resolve(...)`.
 */
export interface PrivacyGuardService {
  /**
   * Transform an outbound LLM payload (system + messages) ahead of a
   * `messages.create` / `messages.stream` call. Idempotent: calling
   * twice with the same payload yields the same tokens (within the
   * lifetime of the per-session map).
   */
  processOutbound(request: PrivacyOutboundRequest): Promise<PrivacyOutboundResult>;
  /**
   * Restore tokens to their original values in an inbound text fragment.
   * Safe to call any number of times per turn (streaming).
   */
  processInbound(request: PrivacyInboundRequest): Promise<PrivacyInboundResult>;
  /**
   * Emit the aggregated user-facing receipt for the turn and free the
   * per-turn accumulator. Returns `undefined` when no `processOutbound`
   * was ever called for this `turnId` (e.g. the orchestrator skipped the
   * hook because no provider was registered, then later asked anyway).
   *
   * Idempotent: a second call with the same `turnId` returns `undefined`.
   * The per-session tokenise-map is NOT cleared — it lives on across
   * turns until the session-lifecycle layer (Slice 2.4) drops it.
   */
  finalizeTurn(turnId: string): Promise<PrivacyReceipt | undefined>;
  /**
   * Slice 2.2 — restore tokens in a tool-call's input arguments before
   * the orchestrator dispatches the tool handler. Walks the input
   * recursively; every string field gets `tok_<hex>` substrings
   * replaced by the bound original via the session's tokenise-map.
   * Idempotent on already-restored input (no tokens → pass-through).
   * Returns a `tokensRestored` count for receipt telemetry.
   */
  processToolInput(request: PrivacyToolInputRequest): Promise<PrivacyToolInputResult>;
  /**
   * Slice 2.2 — tokenise / redact PII in a tool-call's text result
   * before it goes back to the LLM as a `tool_result` block. Mirrors
   * `processOutbound` for the tool-result path: detector hits land in
   * the SAME turn-accumulator (same receipt, same detectorRuns) so
   * tool roundtrips don't fragment the user-facing summary.
   */
  processToolResult(request: PrivacyToolResultRequest): Promise<PrivacyToolResultResult>;
}

// ---------------------------------------------------------------------------
// Slice 3.1 — Detector-Plugin-API.
//
// The privacy-guard service multiplexes any number of detector plugins. Each
// detector scans a string and returns hits; the service runs them in parallel
// and dedups overlapping spans (highest confidence wins; ties broken by the
// shorter/more-specific span). This decouples the host detector
// (`privacy.redact@1` provider, regex-based default) from add-on detectors
// (`privacy.detector@1` providers, e.g. Ollama-NER from Slice 3.2 or Presidio
// from Slice 3.4) so neither has to fork the service to ship.
// ---------------------------------------------------------------------------

/**
 * Service-registry name + capability id for a detector-registry endpoint
 * published by the privacy-guard plugin. Detector add-on plugins resolve
 * this service via `ctx.services.get(PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME)`
 * and call `register(detector)` at activate time.
 *
 * The capability id `privacy.detector@1` is what add-on detector plugins
 * declare in their manifest's `requires` block — the kernel boot-checks
 * the privacy-guard plugin is present before activating the add-on.
 */
export const PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME = 'privacyDetectorRegistry';
export const PRIVACY_DETECTOR_CAPABILITY = 'privacy.detector@1';

/**
 * One PII / sensitive-content match emitted by a detector. INTERNAL —
 * `value` and `span` never leave the privacy-guard process boundary.
 * The user-facing `PrivacyDetection` aggregates these into PII-free
 * counts.
 */
export interface PrivacyDetectorHit {
  /** Free-form type label, e.g. `pii.email`, `pii.name`, `business.contract_clause`.
   *  The receipt assembler groups by `(type, action, detector)`; new types do
   *  not require a schema update. */
  readonly type: string;
  /** Original substring matched. Used for the tokenise-map lookup; never
   *  surfaces in the receipt. */
  readonly value: string;
  /** `[start, end)` offsets in the source string (UTF-16 code units, the
   *  JS-native unit). Used for replacement and span-overlap dedup; never
   *  surfaces in the receipt. */
  readonly span: readonly [number, number];
  /** Confidence in `[0, 1]`. Higher wins span-overlap dedup. */
  readonly confidence: number;
  /** Detector identity emitted with this hit, e.g. `regex:0.1.0`,
   *  `ollama:llama3.2:3b`. May differ across hits from the same detector
   *  if the detector wants to expose sub-engine variants — the receipt
   *  groups detections by this string verbatim. */
  readonly detector: string;
}

/**
 * Slice 3.2.2 — per-detector scan-target filter.
 *
 * The privacy-guard service slices each outbound payload into targets
 * (system prompt, user messages, assistant messages) and asks every
 * registered detector to scan each target. This is wasteful for slow
 * detectors that have no business inspecting the static parts:
 *   - The Ollama NER detector spends ~14s on a 22kb system prompt
 *     that is 99% Tool-Doc + Capability list and has no user PII.
 *   - The result is a 12×-call timeout storm in real tenant turns.
 *
 * `scanTargets` lets a detector opt out of specific kinds. Default
 * (undefined) keeps Slice-3.1 behaviour: scan everything. Setting any
 * field to `false` skips that target — the privacy-guard service
 * filters the detector out for matching targets before the parallel
 * fan-out, so `recordOutcome` never fires for the skipped slot.
 *
 * The regex detector keeps the default (scan everything) — it is
 * deterministic and microsecond-fast even on 32kb inputs, and that
 * coverage is what catches structured PII (email/IBAN/phone+/api-key)
 * inside memory recalls embedded in the system prompt.
 */
export interface PrivacyDetectorScanTargets {
  /** Whether to scan the orchestrator's system prompt. Default true. */
  readonly systemPrompt?: boolean;
  /** Whether to scan messages with role `'user'`. Default true. */
  readonly userMessages?: boolean;
  /** Whether to scan messages with role `'assistant'`. Default true.
   *  Assistant messages typically come from prior turns of the same
   *  conversation; they often carry the same tokens as the user input,
   *  so excluding them rarely changes recall but cuts compute. */
  readonly assistantMessages?: boolean;
}

/**
 * A pluggable PII / sensitive-content detector. Implementations wrap a
 * regex pass, a local NER call, a Presidio HTTP request, or anything else
 * that takes a string and returns hits.
 *
 * Contract:
 *   - `id` is stable for the lifetime of the detector instance and is the
 *     receipt-aggregation key. Conventionally `<engine>:<version>`.
 *   - `detect` MUST be safe to call concurrently — the privacy-guard
 *     service runs all registered detectors in parallel via `Promise.all`
 *     on every outbound payload.
 *   - The detector should map every internal failure to
 *     `{ hits: [], status: 'error' | 'timeout' | 'skipped', reason }`.
 *     A thrown exception is caught by the service-layer wrap as
 *     `{ hits: [], status: 'error' }` for defence-in-depth, but the
 *     primary fail-open contract lives inside the detector so the
 *     `reason` is meaningful.
 *   - Optional `scanTargets` lets a slow detector opt out of specific
 *     target kinds (typically `systemPrompt: false`). Omitted ⇒ scan
 *     everything (Slice-3.1 default).
 */
export interface PrivacyDetector {
  readonly id: string;
  readonly scanTargets?: PrivacyDetectorScanTargets;
  detect(text: string): Promise<PrivacyDetectorOutcome>;
}

/**
 * Service published by the privacy-guard plugin so add-on detector plugins
 * can register at activate-time. The registry is a thin facade over the
 * privacy-guard service's internal detector list — `register` returns a
 * dispose handle the add-on plugin's `close()` MUST invoke so deactivation
 * really removes the detector from the next outbound pass.
 *
 * Activation ordering: privacy-guard MUST activate before any detector
 * add-on (the kernel resolves `requires: privacy.detector@1` against the
 * registry's `provides` declaration). Late registrations after the host
 * has started serving turns are safe — the privacy-guard service iterates
 * its current list on every `processOutbound`, so a fresh registration
 * picks up on the next call.
 */
export interface PrivacyDetectorRegistry {
  /**
   * Register a detector. Returns a dispose handle that removes it from the
   * privacy-guard's active list. Calling dispose twice is a no-op. Two
   * detectors with the same `id` are tolerated — both run; receipts
   * aggregate them under the same `detector` bucket.
   */
  register(detector: PrivacyDetector): () => void;
  /** Snapshot of currently-registered detectors. Useful for
   *  introspection / tests; not used on the hot path. */
  list(): readonly PrivacyDetector[];
}
