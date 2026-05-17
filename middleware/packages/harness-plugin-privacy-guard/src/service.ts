/**
 * Service factory for `privacy.redact@1` (Slice 2.1).
 *
 * Pure function — takes config and returns a stateful `PrivacyGuardService`
 * that the plugin's `activate` publishes via `ctx.services.provide`. Kept
 * as a free function (not a class) so tests can construct without a
 * `PluginContext`.
 *
 * State held by the returned service (Privacy-Shield v2 / Slice S-2):
 *   - `Map<turnId, TokenizeMap>` — turn-scoped token bindings. Same
 *     value within ONE turn always yields the same token (outbound,
 *     tool-input, tool-result and inbound calls of the turn all share
 *     the same map → intra-turn reconciliation). The map is dropped
 *     by `finalizeTurn` so the PII bindings are eligible for garbage
 *     collection. Cross-turn token identity is NOT preserved; the LLM
 *     keeps coherence via the assistant-tail of real (restored) values.
 *   - `Map<turnId, TurnAccumulator>` — per-turn detection bucket. Each
 *     `processOutbound` call appends to it; `finalizeTurn` drains and
 *     emits a single PII-free receipt aggregating every LLM call in the
 *     turn (main + sub-agents).
 *
 * Call shape per turn:
 *
 *   for each LLM call (main agent + each sub-agent iteration):
 *     processOutbound({ sessionId, turnId, ... })
 *       -> tokenised payload + routing decision
 *     <orchestrator does messages.create/stream with the tokenised payload>
 *     processInbound({ sessionId, turnId, text }) (one or many)
 *       -> restored text
 *
 *   at turn end, exactly once:
 *     finalizeTurn(turnId) -> aggregated receipt
 */

import type {
  DetectionAction,
  PolicyMode,
  PrivacyDetector,
  PrivacyDetectorHit,
  PrivacyDetectorOutcome,
  PrivacyDetectorRun,
  PrivacyDetectorStatus,
  PrivacyEgressConfig,
  PrivacyEgressMode,
  PrivacyEgressRequest,
  PrivacyEgressResult,
  PrivacyLiveTestResult,
  PrivacyGuardService,
  PrivacyInboundRequest,
  PrivacyInboundResult,
  PrivacyOutboundMessage,
  PrivacyOutboundRequest,
  PrivacyOutboundResult,
  PrivacyOutputValidationRequest,
  PrivacyOutputValidationResult,
  PrivacyPostEgressScrubResult,
  PrivacyReceipt,
  PrivacySelfAnonymizationRequest,
  PrivacySelfAnonymizationResult,
  PrivacyToolInputRequest,
  PrivacyToolInputResult,
  PrivacyToolResultRequest,
  PrivacyToolResultResult,
  Routing,
} from '@omadia/plugin-api';

import { assembleReceipt, type AssembledHit } from './receiptAssembler.js';
import { decide, deriveRouting, type PolicyDecision } from './policyEngine.js';
import { runEgressFilter } from './egressFilter.js';
import {
  extractPersonTokenOrder,
  restoreOrScrubRemainingTokens,
  restoreSelfAnonymization,
  restoreUnresolvedPersonTokens,
} from './selfAnonymization.js';
import { extendHitsToWordBoundary } from './spanHelpers.js';
import { createRegexDetector } from './regexDetector.js';
import { TOKEN_REGEX, createTokenizeMap, type TokenizeMap } from './tokenizeMap.js';
import {
  createAllowlist,
  filterHitsByAllowlist,
  type Allowlist,
  type AllowlistConfig,
  type AllowlistMatch,
} from './allowlist.js';

export interface PrivacyGuardServiceDeps {
  /** Default policy mode applied when the request does not pin one. */
  readonly defaultPolicyMode: PolicyMode;
  /** Override for tests; production should let the service mint its own
   *  per-turn map via `createTokenizeMap()`. */
  readonly tokenizeMapFactory?: () => TokenizeMap;
  /**
   * Slice 3.1: seed list of detectors. The service runs them in parallel
   * on every outbound payload and dedups overlapping spans. Empty / omitted
   * → the service bundles the regex detector as a default so the
   * Slice-2.1 behaviour holds without a configuration change. Add-on
   * plugins (Slice 3.2 Ollama, Slice 3.4 Presidio) register at runtime
   * via the {@link PrivacyDetectorRegistry} the plugin publishes.
   */
  readonly detectors?: readonly PrivacyDetector[];
  /**
   * Slice 3.2.1 operator-toggle. When `true`, the receipt assembler
   * emits `values` arrays inside detection rows (tokenized only) and a
   * top-level `debug: true` flag. Default `false` — production receipts
   * stay PII-free by construction.
   *
   * The toggle lives at service level (not per-request) because every
   * detection in the turn shares the same trust context — the receipt
   * is either a debug receipt or it isn't.
   */
  readonly debugShowValues?: boolean;
  /**
   * Privacy-Shield v2 (Slice S-3) — pre-detector allowlist. Spans
   * matching any configured term are exempted from the detector pool
   * before policy decisions. Omit / pass empty arrays for a no-op
   * allowlist (this is the default; existing tests stay unaffected).
   *
   * The host assembles the three source lists at plugin-activate time
   * from (a) the operator profile (tenant-self), (b) the bundled
   * repo-default JSON, (c) the plugin config field
   * `extra_allowlist_terms`. Re-activating the plugin re-builds the
   * allowlist; the service does not hot-reload mid-turn.
   */
  readonly allowlist?: AllowlistConfig;
  /**
   * Privacy-Shield v2 (Slice S-5) — Output Validator threshold for
   * the token-loss ratio. When the LLM emitted less than
   * `(1 - threshold) × tokensMinted` distinct minted tokens in its
   * response, the recommendation escalates to `retry`. Default `0.3`
   * (30 %).
   */
  readonly tokenLossThreshold?: number;
  /**
   * Privacy-Shield v2 (Slice S-6) — default egress-filter reaction
   * mode applied when a `egressFilter` request omits `mode`. The
   * plugin reads `egress_filter_mode` from the operator config at
   * activate time; falls back to `'mask'` when unset (production
   * default — masks the spontaneous PII inline without dropping the
   * answer).
   */
  readonly egressFilterMode?: PrivacyEgressMode;
  /**
   * Privacy-Shield v2 (Slice S-6) — master switch surfaced through
   * `getEgressConfig()` so hosts (orchestrator, routine runner) can
   * skip the call cheaply when the operator disabled the filter.
   * Defaults to `true` when omitted.
   */
  readonly egressFilterEnabled?: boolean;
  /**
   * Privacy-Shield v2 (Slice S-6) — placeholder string the host
   * substitutes for the final answer when the filter returns
   * `routing: 'blocked'`. Surfaced via `getEgressConfig()`. The
   * service does not perform the swap itself; that lives at the
   * integration boundary.
   */
  readonly egressBlockPlaceholderText?: string;
}

/**
 * Slice 3.1: Internal interface — extends the public `PrivacyGuardService`
 * with the registry surface used by the plugin entry point. Not exposed
 * on the orchestrator-facing service so consumers cannot accidentally
 * mutate the detector list during a turn.
 */
export interface PrivacyGuardServiceInternal extends PrivacyGuardService {
  registerDetector(detector: PrivacyDetector): () => void;
  listDetectors(): readonly PrivacyDetector[];
}

/** Internal per-turn accumulator. Aggregates detections from every
 *  outbound call within the turn so `finalizeTurn` can build one receipt. */
interface TurnAccumulator {
  readonly turnId: string;
  readonly sessionId: string;
  readonly policyMode: PolicyMode;
  readonly startedAt: number;
  readonly hits: AssembledHit[];
  /** Concatenated original-payload chunks. Hashed at finalize for the
   *  receipt's `auditHash`. PII-free in the receipt itself; only the
   *  hash crosses the boundary. */
  readonly originalChunks: string[];
  /** Worst routing seen across all calls in this turn. `blocked` wins
   *  over `public-llm`. */
  worstRouting: Routing;
  routingReason: string | undefined;
  /** Slice 3.2.1: per-detector run summaries. Keyed by detector id; one
   *  bucket per detector that exists in any turn-snapshot. */
  readonly detectorRuns: Map<string, DetectorRunAccum>;
  /**
   * Slice 3.2.2: turn-scoped single-flight cache. Map keyed by
   * `<detectorId>|<text>` to the in-flight (or settled) outcome
   * promise. Lets the same `(detector, text)` tuple within a single
   * turn share one detector invocation across N concurrent or
   * sequential calls — the typical case being identical 22kb
   * system-prompts replayed across main + sub-agent + iteration
   * outbounds.
   *
   * Cache is dropped when the turn is finalised. New turns get a
   * fresh shot at every input — a transient `timeout` should not
   * permanently silence the detector for the rest of the session.
   */
  readonly inflightCache: Map<string, Promise<PrivacyDetectorOutcome>>;
  /** Slice 2.2 — tool-roundtrip telemetry. Incremented by
   *  `processToolInput` (argsRestored counts how many string values had
   *  ≥1 token restored across all input invocations) and
   *  `processToolResult` (resultsTokenized counts how many result texts
   *  were transformed). `callCount` is the sum of both call sites so
   *  the receipt can show e.g. "4 tool roundtrips" for 2 inputs + 2
   *  results. Stays `0/0/0` when the turn never used a tool. */
  toolRoundtripArgsRestored: number;
  toolRoundtripResultsTokenized: number;
  toolRoundtripCallCount: number;
  /** Privacy-Shield v2 (Slice S-3) — per-source allowlist hit counts
   *  aggregated across every `transformOne` call within the turn.
   *  Surfaced as `receipt.allowlist.bySource` at `finalizeTurn` when
   *  any source fired. PII-free: counts only, never the matched term. */
  allowlistHits: { tenantSelf: number; repoDefault: number; operatorOverride: number };
  /** Privacy-Shield v2 (Slice S-5) — distinct minted tokens the LLM
   *  referenced in its responses, counted in `processInbound` before
   *  restore. Used as the numerator of the token-loss ratio. Stored
   *  as a Set so repeated references don't inflate the count
   *  artificially. */
  readonly tokensSeenInInbound: Set<string>;
  /** Privacy-Shield v2 (Slice S-5) — Output Validator result for the
   *  turn. Populated by `validateOutput`; absent when the host never
   *  called the validator. Surfaced as `receipt.output` at finalize. */
  outputValidation: PrivacyOutputValidationResult | undefined;
  /** Privacy-Shield v2 (Slice S-6) — Egress Filter summary for the
   *  turn. Set by `egressFilter`; absent when the host never called
   *  it. Surfaced as `receipt.egress` at finalize. PII-free: the
   *  detector-runs / counts / routing only. */
  egressSummary:
    | {
        readonly mode: PrivacyEgressMode;
        readonly routing: PrivacyEgressResult['routing'];
        readonly detectorRuns: readonly PrivacyDetectorRun[];
        readonly spontaneousHits: number;
        readonly maskedCount: number;
      }
    | undefined;
  /**
   * Privacy-Shield v2 (Phase A, post-deploy 2026-05-14) — captured
   * after the most recent `processToolResult`. De-duplicated, in-order
   * `«PERSON_N»` sequence from the transformed tool-result text.
   *
   * The positional source for `restoreSelfAnonymizationLabels`: when
   * the LLM emits "Mitarbeiter 1 / 2 / 3" referring to the rows of a
   * tool result, index N corresponds to the N-th `«PERSON_N»` that
   * appeared in that tool result — NOT the N-th token minted across
   * the whole turn, because earlier user-mentioned names occupy lower
   * mint counters but do not belong to the table-positional view.
   *
   * Overwritten on every tool-result invocation: the LATEST result is
   * the most likely positional referent. A future slice may extend
   * this to a per-tool-name map when multi-tool synthesis surfaces
   * cross-result label ambiguity.
   */
  lastToolResultPersonTokenOrder: readonly string[];
  /**
   * Privacy-Shield v2 (Phase A) — per-turn restoration summary,
   * surfaced as `receipt.selfAnonymization` so operators see how
   * many label patterns the LLM emitted and how many we restored.
   * Absent when `restoreSelfAnonymizationLabels` was never invoked
   * for this turn. PII-free: counts + lowercase keyword stems only.
   */
  selfAnonymizationSummary:
    | {
        readonly detected: number;
        readonly restored: number;
        readonly ambiguous: number;
        readonly patternsHit: readonly string[];
        readonly maxIndexSeen: number;
        readonly tokenOrderLength: number;
      }
    | undefined;
  /**
   * Privacy-Shield v2 (Phase A.2) — final-scrub telemetry. Populated
   * by `restoreOrScrubRemainingTokens`. Aggregated into
   * `receipt.postEgressScrub` at finalize.
   */
  postEgressScrubSummary:
    | {
        readonly restoredPositional: number;
        readonly scrubbedToPlaceholder: number;
      }
    | undefined;
}

/** Mutable per-detector accumulator. Aggregated into `PrivacyDetectorRun`
 *  at `finalizeTurn` time. */
interface DetectorRunAccum {
  readonly detector: string;
  status: PrivacyDetectorStatus;
  callCount: number;
  hitCount: number;
  latencyMs: number;
  reason: string | undefined;
}

/**
 * Slice 3.2.2 — per-target slice of the outbound payload. The `role`
 * mirrors the original `PrivacyOutboundMessage.role` so the
 * detector-scanTargets filter can distinguish user vs assistant
 * messages without re-walking the request shape.
 */
type TextTarget =
  | { readonly kind: 'system'; readonly source: string }
  | {
      readonly kind: 'message';
      readonly index: number;
      readonly role: 'user' | 'assistant' | 'system';
      readonly source: string;
    };

/**
 * Slice 3.2.2 — given a detector and a target, decide whether the
 * detector wants to scan this target at all. Default (no scanTargets
 * declared) is scan-all — Slice-3.1 backwards compat.
 */
function detectorScansTarget(d: PrivacyDetector, target: TextTarget): boolean {
  const targets = d.scanTargets;
  if (targets === undefined) return true;
  if (target.kind === 'system') return targets.systemPrompt !== false;
  // target.kind === 'message'
  if (target.role === 'user') return targets.userMessages !== false;
  if (target.role === 'assistant') return targets.assistantMessages !== false;
  // role === 'system' on a message slot is unusual; defer to systemPrompt.
  return targets.systemPrompt !== false;
}

/**
 * Privacy-Shield v2 (Slice S-6) — fallback placeholder string surfaced
 * via `getEgressConfig()` when neither plugin config nor the service
 * deps supplied one. Kept in English so unconfigured tenants get a
 * universally-understandable refusal rather than a German default
 * that would surprise an EN-only operator.
 */
const DEFAULT_EGRESS_PLACEHOLDER_TEXT =
  'The response was withheld because it contained data the privacy filter could not verify. Please rephrase your request.';

/** Severity rank for `PrivacyDetectorStatus`. Used to fold per-call
 *  outcomes into a turn-wide worst status. `error > timeout > skipped > ok`. */
function statusRank(s: PrivacyDetectorStatus): number {
  switch (s) {
    case 'ok':
      return 0;
    case 'skipped':
      return 1;
    case 'timeout':
      return 2;
    case 'error':
      return 3;
  }
}

export function createPrivacyGuardService(
  deps: PrivacyGuardServiceDeps,
): PrivacyGuardServiceInternal {
  const factory = deps.tokenizeMapFactory ?? createTokenizeMap;
  // Privacy-Shield v2 (Slice S-2): the tokenise-map is scoped per TURN,
  // not per session. The map is minted lazily on the first
  // `processOutbound` / `processToolResult` of a turn and discarded
  // together with the accumulator in `finalizeTurn`. Cross-turn token
  // identity is therefore NOT preserved — the LLM's coherence across
  // turns comes from the assistant-tail (which references real values
  // after restore), not from stable token names.
  const turnMaps = new Map<string, TokenizeMap>();
  const turnAccumulators = new Map<string, TurnAccumulator>();
  // Privacy-Shield v2 (Slice S-3): build the allowlist at service
  // construction. Re-activating the plugin re-runs the factory.
  // Privacy-Shield v2 (Slice S-7): the operator-override list is
  // mutable at runtime via `setOperatorOverrideTerms` from the
  // Operator-UI; we hold the resolved config + the live Allowlist
  // separately so rebuilds are local.
  let allowlistConfig: AllowlistConfig = deps.allowlist ?? {};
  let allowlist: Allowlist = createAllowlist(allowlistConfig);
  // Slice 3.1: detector list. Empty seed → bundle the regex detector as
  // default so existing single-detector behaviour holds without config.
  // Detectors registered after the service is built (Slice 3.2 Ollama
  // add-on) append here; the next outbound pass picks them up.
  const detectors: PrivacyDetector[] =
    deps.detectors && deps.detectors.length > 0
      ? [...deps.detectors]
      : [createRegexDetector()];

  function mapFor(turnId: string): TokenizeMap {
    let m = turnMaps.get(turnId);
    if (m === undefined) {
      m = factory();
      turnMaps.set(turnId, m);
    }
    return m;
  }

  function accumulatorForIds(sessionId: string, turnId: string): TurnAccumulator {
    let acc = turnAccumulators.get(turnId);
    if (acc === undefined) {
      acc = {
        turnId,
        sessionId,
        policyMode: deps.defaultPolicyMode,
        startedAt: Date.now(),
        hits: [],
        originalChunks: [],
        worstRouting: 'public-llm',
        routingReason: undefined,
        detectorRuns: new Map<string, DetectorRunAccum>(),
        inflightCache: new Map<string, Promise<PrivacyDetectorOutcome>>(),
        toolRoundtripArgsRestored: 0,
        toolRoundtripResultsTokenized: 0,
        toolRoundtripCallCount: 0,
        allowlistHits: { tenantSelf: 0, repoDefault: 0, operatorOverride: 0 },
        tokensSeenInInbound: new Set<string>(),
        outputValidation: undefined,
        egressSummary: undefined,
        lastToolResultPersonTokenOrder: [],
        selfAnonymizationSummary: undefined,
        postEgressScrubSummary: undefined,
      };
      turnAccumulators.set(turnId, acc);
    }
    return acc;
  }

  function accumulatorFor(req: PrivacyOutboundRequest): TurnAccumulator {
    return accumulatorForIds(req.sessionId, req.turnId);
  }

  /** Fold a single `detect()` outcome into the per-detector accumulator
   *  for this turn. Worst-status wins; latency / hitCount / callCount
   *  accumulate. */
  function recordOutcome(
    acc: TurnAccumulator,
    detectorId: string,
    outcome: PrivacyDetectorOutcome,
    latencyMs: number,
  ): void {
    let bucket = acc.detectorRuns.get(detectorId);
    if (bucket === undefined) {
      bucket = {
        detector: detectorId,
        status: outcome.status,
        callCount: 0,
        hitCount: 0,
        latencyMs: 0,
        reason: outcome.reason,
      };
      acc.detectorRuns.set(detectorId, bucket);
    } else if (statusRank(outcome.status) > statusRank(bucket.status)) {
      bucket.status = outcome.status;
      bucket.reason = outcome.reason;
    }
    bucket.callCount += 1;
    bucket.hitCount += outcome.hits.length;
    bucket.latencyMs += latencyMs;
  }

  /** Privacy-Shield v2 (Slice S-3) — increment per-source allowlist
   *  counters on the turn accumulator. PII-free: counts only. */
  function recordAllowlistMatches(
    acc: TurnAccumulator,
    matches: readonly AllowlistMatch[],
  ): void {
    if (matches.length === 0) return;
    for (const m of matches) {
      acc.allowlistHits[m.source] += 1;
    }
  }

  return {
    async processOutbound(
      request: PrivacyOutboundRequest,
    ): Promise<PrivacyOutboundResult> {
      const map = mapFor(request.turnId);
      const acc = accumulatorFor(request);

      const augmentedSystemPrompt = augmentSystemPromptForPrivacyProxy(
        request.systemPrompt,
      );

      const targets: TextTarget[] = [
        { kind: 'system', source: augmentedSystemPrompt },
        ...request.messages.map(
          (m, i): TextTarget => ({
            kind: 'message',
            index: i,
            role: m.role,
            source: m.content,
          }),
        ),
      ];

      const localDecisions: PolicyDecision[] = [];
      // Slice 3.1: snapshot the detector list once per call so a mid-call
      // registration (extremely unlikely) doesn't fan in / out across the
      // targets within the same outbound pass.
      const detectorSnapshot: readonly PrivacyDetector[] = [...detectors];
      // Slice 3.2.1: every detector that's registered AT ALL gets a
      // `PrivacyDetectorRun` row in the receipt, even if it never fires.
      // Pre-touch the bucket so a 0-call detector still surfaces.
      for (const d of detectorSnapshot) {
        if (!acc.detectorRuns.has(d.id)) {
          acc.detectorRuns.set(d.id, {
            detector: d.id,
            status: 'ok',
            callCount: 0,
            hitCount: 0,
            latencyMs: 0,
            reason: undefined,
          });
        }
      }
      const transformed = await Promise.all(
        targets.map((t) =>
          transformOne(t, {
            policyMode: acc.policyMode,
            agentId: request.agentId,
            map,
            collect: acc.hits,
            collectDecisions: localDecisions,
            detectors: detectorSnapshot,
            inflightCache: acc.inflightCache,
            recordOutcome: (id, outcome, latencyMs) => recordOutcome(acc, id, outcome, latencyMs),
            allowlist,
            recordAllowlistMatches: (matches) => recordAllowlistMatches(acc, matches),
          }),
        ),
      );

      const newSystem = transformed[0]?.text ?? augmentedSystemPrompt;
      const newMessages: PrivacyOutboundMessage[] = request.messages.map((m, i) => {
        const content = transformed[i + 1]?.text ?? m.content;
        return content === m.content ? m : { role: m.role, content };
      });

      // Routing: the call-level decision wins for this call (the host has
      // to abort if blocked), but the turn-level worst routing also has
      // to remember it for the final receipt.
      const callRouting = deriveRouting(localDecisions);
      if (callRouting.routing === 'blocked' && acc.worstRouting !== 'blocked') {
        acc.worstRouting = 'blocked';
        if (callRouting.routingReason !== undefined && acc.routingReason === undefined) {
          acc.routingReason = callRouting.routingReason;
        }
      }

      acc.originalChunks.push(serialiseOriginal(request));

      return {
        systemPrompt: newSystem,
        messages: newMessages,
        routing: callRouting.routing,
      };
    },

    async processInbound(
      request: PrivacyInboundRequest,
    ): Promise<PrivacyInboundResult> {
      const map = turnMaps.get(request.turnId);
      if (map === undefined) {
        // No outbound was ever processed for this turn — nothing to
        // restore. Pass-through.
        return { text: request.text };
      }
      // Privacy-Shield v2 (Slice S-5): before restoring, fold every
      // recognised token into the turn's "seen" set so the Output
      // Validator can compute the token-loss ratio at end-of-turn.
      // Unknown tokens (no map entry) are ignored here — the validator
      // treats them as a separate "unrestored token" signal.
      const acc = turnAccumulators.get(request.turnId);
      if (acc !== undefined && request.text.includes('«')) {
        const matches = request.text.match(TOKEN_REGEX);
        if (matches !== null) {
          for (const tok of matches) {
            if (map.resolve(tok) !== undefined) {
              acc.tokensSeenInInbound.add(tok);
            }
          }
        }
      }
      return { text: restoreTokens(request.text, map) };
    },

    async finalizeTurn(turnId: string): Promise<PrivacyReceipt | undefined> {
      const acc = turnAccumulators.get(turnId);
      if (acc === undefined) return undefined;
      turnAccumulators.delete(turnId);
      // Privacy-Shield v2 (Slice S-2): drop the per-turn tokenise-map so
      // its PII bindings are eligible for garbage collection. A
      // subsequent processInbound for this turn — should one fire after
      // finalize, which would be a host bug — pass-throughs because the
      // map is gone.
      turnMaps.delete(turnId);

      if (deps.debugShowValues === true) {
        // Slice 2.2 dev-instrumentation: when the operator has explicitly
        // opted into debug_show_values, dump the raw aggregated hits to
        // the log so we can verify what each detector actually returned.
        // Already a PII-carrying mode; this adds no new privacy
        // concern. Disable by flipping the plugin setting back.
        const summary = acc.hits.map((h) => ({
          type: h.type,
          action: h.action,
          detector: h.detector,
          value: h.value,
        }));
        console.log(
          `[privacy-guard] finalizeTurn turn=${turnId} hits=${String(acc.hits.length)} debug-summary=${JSON.stringify(summary)}`,
        );
      }

      const detectorRuns: PrivacyDetectorRun[] = [...acc.detectorRuns.values()].map((b) => ({
        detector: b.detector,
        status: b.status,
        callCount: b.callCount,
        hitCount: b.hitCount,
        latencyMs: b.latencyMs,
        ...(b.reason !== undefined ? { reason: b.reason } : {}),
      }));

      const allowlistTotal =
        acc.allowlistHits.tenantSelf +
        acc.allowlistHits.repoDefault +
        acc.allowlistHits.operatorOverride;

      const receipt = assembleReceipt({
        hits: acc.hits,
        policyMode: acc.policyMode,
        routing: acc.worstRouting,
        ...(acc.routingReason !== undefined ? { routingReason: acc.routingReason } : {}),
        latencyMs: Math.max(0, Date.now() - acc.startedAt),
        originalPayload: acc.originalChunks.join('\n---\n'),
        detectorRuns,
        ...(deps.debugShowValues === true ? { debugShowValues: true } : {}),
        ...(acc.toolRoundtripCallCount > 0
          ? {
              toolRoundtrip: {
                argsRestored: acc.toolRoundtripArgsRestored,
                resultsTokenized: acc.toolRoundtripResultsTokenized,
                callCount: acc.toolRoundtripCallCount,
              },
            }
          : {}),
        ...(allowlistTotal > 0
          ? {
              allowlist: {
                hitCount: allowlistTotal,
                bySource: {
                  tenantSelf: acc.allowlistHits.tenantSelf,
                  repoDefault: acc.allowlistHits.repoDefault,
                  operatorOverride: acc.allowlistHits.operatorOverride,
                },
              },
            }
          : {}),
        ...(acc.outputValidation !== undefined
          ? {
              output: {
                tokenLossRatio: acc.outputValidation.tokenLossRatio,
                spontaneousPiiHits: acc.outputValidation.spontaneousPiiHits.length,
                recommendation: acc.outputValidation.recommendation,
                ...(acc.outputValidation.recommendationReason !== undefined
                  ? { recommendationReason: acc.outputValidation.recommendationReason }
                  : {}),
              },
            }
          : {}),
        ...(acc.egressSummary !== undefined
          ? {
              egress: {
                mode: acc.egressSummary.mode,
                routing: acc.egressSummary.routing,
                detectorRuns: acc.egressSummary.detectorRuns,
                spontaneousHits: acc.egressSummary.spontaneousHits,
                maskedCount: acc.egressSummary.maskedCount,
              },
            }
          : {}),
        ...(acc.selfAnonymizationSummary !== undefined
          ? {
              selfAnonymization: {
                detected: acc.selfAnonymizationSummary.detected,
                restored: acc.selfAnonymizationSummary.restored,
                ambiguous: acc.selfAnonymizationSummary.ambiguous,
                patternsHit: acc.selfAnonymizationSummary.patternsHit,
                maxIndexSeen: acc.selfAnonymizationSummary.maxIndexSeen,
                tokenOrderLength: acc.selfAnonymizationSummary.tokenOrderLength,
              },
            }
          : {}),
        ...(acc.postEgressScrubSummary !== undefined
          ? {
              postEgressScrub: {
                restoredPositional: acc.postEgressScrubSummary.restoredPositional,
                scrubbedToPlaceholder: acc.postEgressScrubSummary.scrubbedToPlaceholder,
              },
            }
          : {}),
      });
      return receipt;
    },

    async processToolInput(
      request: PrivacyToolInputRequest,
    ): Promise<PrivacyToolInputResult> {
      const acc = accumulatorForIds(request.sessionId, request.turnId);
      acc.toolRoundtripCallCount += 1;
      const map = turnMaps.get(request.turnId);
      if (map === undefined) {
        // No outbound was ever processed for this turn — there are no
        // tokens to restore. Pass-through.
        return { input: request.input, tokensRestored: 0 };
      }
      let restoredCount = 0;
      const walk = (v: unknown): unknown => {
        if (typeof v === 'string') {
          if (!v.includes('«')) return v;
          const restored = restoreTokens(v, map);
          if (restored !== v) restoredCount += 1;
          return restored;
        }
        if (Array.isArray(v)) return v.map(walk);
        if (v !== null && typeof v === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            out[k] = walk(val);
          }
          return out;
        }
        return v;
      };
      const restoredInput = walk(request.input);
      acc.toolRoundtripArgsRestored += restoredCount;
      return { input: restoredInput, tokensRestored: restoredCount };
    },

    async processToolResult(
      request: PrivacyToolResultRequest,
    ): Promise<PrivacyToolResultResult> {
      const acc = accumulatorForIds(request.sessionId, request.turnId);
      acc.toolRoundtripCallCount += 1;

      // Empty result: nothing to scan, nothing to transform.
      if (request.text.length === 0) {
        return { text: request.text, transformed: false };
      }

      const detectorSnapshot: readonly PrivacyDetector[] = [...detectors];
      // Pre-touch detector buckets so a 0-call detector still surfaces in
      // the receipt — same contract as processOutbound.
      for (const d of detectorSnapshot) {
        if (!acc.detectorRuns.has(d.id)) {
          acc.detectorRuns.set(d.id, {
            detector: d.id,
            status: 'ok',
            callCount: 0,
            hitCount: 0,
            latencyMs: 0,
            reason: undefined,
          });
        }
      }

      const localDecisions: PolicyDecision[] = [];
      // Tool results are user-facing data coming back from external
      // systems (Odoo, calendar, knowledge graph). They look more like a
      // user message than a system prompt for the purpose of detector
      // scan-target filtering — `role: 'user'` keeps presidio + ollama
      // engaged, which is the whole point of the tool-result re-scan.
      const target: TextTarget = {
        kind: 'message',
        index: -1,
        role: 'user',
        source: request.text,
      };
      const transformed = await transformOne(target, {
        policyMode: acc.policyMode,
        map: mapFor(request.turnId),
        collect: acc.hits,
        collectDecisions: localDecisions,
        detectors: detectorSnapshot,
        inflightCache: acc.inflightCache,
        recordOutcome: (id, outcome, latencyMs) =>
          recordOutcome(acc, id, outcome, latencyMs),
        allowlist,
        recordAllowlistMatches: (matches) => recordAllowlistMatches(acc, matches),
      });

      const wasTransformed = transformed.text !== request.text;
      if (wasTransformed) {
        acc.toolRoundtripResultsTokenized += 1;
      }

      // Privacy-Shield v2 (Phase A) — capture the de-duplicated
      // in-order person-token sequence from this tool result so the
      // mechanical self-anonymization restorer can map LLM-emitted
      // "Mitarbeiter N" labels to the right real names by position.
      // Overwrites the previous capture: the LATEST tool result is
      // the most likely positional referent for the answer the LLM
      // is about to compose.
      acc.lastToolResultPersonTokenOrder = extractPersonTokenOrder(transformed.text);

      // Tool result is part of the turn's outbound surface back to the
      // LLM — feed it into the audit-hash chunks like processOutbound
      // does for system + messages so the auditHash covers the full
      // payload that crossed the wire.
      acc.originalChunks.push(`TOOL_RESULT(${request.toolName}):${request.text}`);

      return { text: transformed.text, transformed: wasTransformed };
    },

    // Privacy-Shield v2 (Slice S-5) — Output Validator. Re-runs the
    // detector pool on the final assistant text (post-restore) and
    // compares each detector hit against the turn-map. Hits whose
    // value WAS in the map are restored tokens (legitimate);
    // hits whose value WAS NOT in the map are "spontaneous PII" —
    // the LLM produced a plausible-looking value rather than passing
    // a token through verbatim. Combined with the token-loss ratio
    // (minted vs. seen-in-inbound), the validator emits a
    // `pass | retry | block` recommendation the host can act on.
    async validateOutput(
      request: PrivacyOutputValidationRequest,
    ): Promise<PrivacyOutputValidationResult> {
      const map = turnMaps.get(request.turnId);
      const acc = turnAccumulators.get(request.turnId);
      const tokensMinted = map?.size ?? 0;
      const tokensRestored = acc?.tokensSeenInInbound.size ?? 0;
      const tokenLossRatio =
        tokensMinted === 0 ? 0 : Math.max(0, 1 - tokensRestored / tokensMinted);

      // Re-run detectors on the final assistant text. Use the same
      // detector pool + dedup pipeline as transformOne so we get
      // consistent classifications. Wrap in a noop allowlist for the
      // re-scan because the allowlist's job is to suppress FPs on the
      // INBOUND scan; we want the FULL detector signal on the output.
      const detectorSnapshot: readonly PrivacyDetector[] = [...detectors];
      const inflightCache = new Map<string, Promise<PrivacyDetectorOutcome>>();
      const allHits = await runDetectors(
        request.assistantText,
        detectorSnapshot,
        inflightCache,
        () => {
          // Detector-run telemetry for the output validator is folded
          // into the same per-detector buckets as the main pass if an
          // accumulator exists; otherwise discarded. This is a
          // best-effort signal (the validator may run without a prior
          // outbound — e.g. the host calls it on a routine's
          // pre-formatted answer).
        },
      );
      const deduped = dedupOverlappingHits(allHits);
      const spontaneousPiiHits: Array<{ type: string; detectorId: string }> = [];
      for (const hit of deduped) {
        if (map === undefined || !map.hasOriginalValue(hit.value)) {
          spontaneousPiiHits.push({ type: hit.type, detectorId: hit.detector });
        }
      }

      const threshold =
        typeof deps.tokenLossThreshold === 'number' &&
        deps.tokenLossThreshold >= 0 &&
        deps.tokenLossThreshold <= 1
          ? deps.tokenLossThreshold
          : 0.3;

      let recommendation: 'pass' | 'retry' | 'block' = 'pass';
      let recommendationReason: string | undefined;
      if (spontaneousPiiHits.length > 0) {
        recommendation = 'block';
        recommendationReason = `spontaneous PII in output (${String(spontaneousPiiHits.length)} hit${spontaneousPiiHits.length === 1 ? '' : 's'})`;
      } else if (tokenLossRatio > threshold) {
        recommendation = 'retry';
        recommendationReason = `token-loss ratio ${tokenLossRatio.toFixed(2)} exceeds threshold ${threshold.toFixed(2)}`;
      }

      const result: PrivacyOutputValidationResult = {
        tokensMinted,
        tokensRestored,
        tokenLossRatio,
        spontaneousPiiHits,
        recommendation,
        ...(recommendationReason !== undefined ? { recommendationReason } : {}),
      };
      if (acc !== undefined) {
        acc.outputValidation = result;
      }
      return result;
    },

    // Privacy-Shield v2 (Slice S-6) — Egress Filter. Re-runs the full
    // detector pool on the final channel-bound text slots, classifies
    // each hit against the turn-map (known → restored PII, unknown →
    // spontaneous), and applies the operator-configured mode. Folds
    // detectorRuns + counters onto the turn accumulator for the
    // `egress` receipt block.
    getEgressConfig(): PrivacyEgressConfig {
      return {
        enabled: deps.egressFilterEnabled !== false,
        mode: deps.egressFilterMode ?? 'mask',
        blockPlaceholderText:
          deps.egressBlockPlaceholderText !== undefined &&
          deps.egressBlockPlaceholderText.trim().length > 0
            ? deps.egressBlockPlaceholderText
            : DEFAULT_EGRESS_PLACEHOLDER_TEXT,
      };
    },

    async egressFilter(
      request: PrivacyEgressRequest,
    ): Promise<PrivacyEgressResult> {
      // Use the turn map if it exists; otherwise mint one (the host
      // may call egressFilter without ever calling processOutbound —
      // e.g. a routine that produced answer purely from a tool result
      // we tokenised via processToolResult, or a unit test). The
      // map's `hasOriginalValue` returns false for everything in the
      // bare-mint case, which means every detection becomes
      // spontaneous — exactly the desired fail-safe.
      const map = mapFor(request.turnId);
      const acc = accumulatorForIds(request.sessionId, request.turnId);
      const defaultMode: PrivacyEgressMode = deps.egressFilterMode ?? 'mask';
      const result = await runEgressFilter(request, {
        detectors: [...detectors],
        map,
        defaultMode,
        allowlist,
      });
      acc.egressSummary = {
        mode: result.mode,
        routing: result.routing,
        detectorRuns: result.detectorRuns,
        spontaneousHits: result.spontaneousHits,
        maskedCount: result.maskedCount,
      };
      return result;
    },

    // Privacy-Shield v2 (Phase A, post-deploy 2026-05-14) — mechanical
    // restoration of LLM self-anonymization labels. Phase A.1 layers
    // unresolved-token gap-fill on top. See module-level comment in
    // selfAnonymization.ts for the design rationale.
    async restoreSelfAnonymizationLabels(
      request: PrivacySelfAnonymizationRequest,
    ): Promise<PrivacySelfAnonymizationResult> {
      const acc = accumulatorForIds(request.sessionId, request.turnId);
      const map = mapFor(request.turnId);
      const tokenOrder = acc.lastToolResultPersonTokenOrder;

      // Pass 1: label-pattern restoration (Mitarbeiter N / Employee N
      // / Person N / …). Indexed by the parsed numeric ordinal.
      const labelOutcome = restoreSelfAnonymization(request.text, tokenOrder, map);

      // Pass 2: unresolved-token gap-fill on the text produced by pass
      // 1. Indexed by left-to-right occurrence of `«TYPE_N»` tokens
      // that have no binding in the turn-map; matched against the set
      // of missing real names (tool-result names not present in the
      // text yet).
      const gapOutcome = restoreUnresolvedPersonTokens(
        labelOutcome.text,
        tokenOrder,
        map,
      );

      const detected = labelOutcome.detected + gapOutcome.detected;
      const restored = labelOutcome.restored + gapOutcome.restored;
      const ambiguous = labelOutcome.ambiguous + gapOutcome.ambiguous;
      const patternsHit = [
        ...new Set([...labelOutcome.patternsHit, ...gapOutcome.patternsHit]),
      ].sort();
      const maxIndexSeen = Math.max(
        labelOutcome.maxIndexSeen,
        gapOutcome.maxIndexSeen,
      );

      // Always update the accumulator — even on a zero-match run — so
      // operators see "detector ran, found nothing" rather than the
      // ambiguous absence in the receipt.
      acc.selfAnonymizationSummary = {
        detected,
        restored,
        ambiguous,
        patternsHit,
        maxIndexSeen,
        tokenOrderLength: tokenOrder.length,
      };

      // Phase A.1 telemetry — operator receipts are not yet persisted
      // (S-7.5 deferred), so the only durable diagnostic surface is
      // stdout. Emit a single per-turn line that lets the operator
      // distinguish "restoration ran clean", "conservative skip
      // fired", and "no labels at all" without a receipt query.
      if (detected > 0 || tokenOrder.length > 0) {
        // Phase A.1+ verbose diagnostic: surface the captured token
        // sequence (just the «PERSON_N» strings, not the underlying
        // PII values) and pre/post text fragments so we can tell why
        // the gap-fill did or didn't fire on the live HR-routine
        // shape. Token strings carry no PII by construction; the
        // surrounding text is the assistant answer which is about
        // to ship to the user anyway. Truncated to keep the log line
        // bounded.
        const previewBefore = request.text.slice(0, 160).replace(/\n/g, '⏎');
        const previewAfter = gapOutcome.text.slice(0, 160).replace(/\n/g, '⏎');
        const unchangedByGap = gapOutcome.text === labelOutcome.text;
        const unchangedByLabel = labelOutcome.text === request.text;
        console.log(
          `[privacy-guard] selfAnon turn=${request.turnId} detected=${String(detected)} ` +
            `restored=${String(restored)} ambiguous=${String(ambiguous)} ` +
            `tokenOrder=${String(tokenOrder.length)} maxIdx=${String(maxIndexSeen)} ` +
            `patterns=[${patternsHit.join(',')}] ` +
            `label-d=${String(labelOutcome.detected)}/r=${String(labelOutcome.restored)} ` +
            `gap-d=${String(gapOutcome.detected)}/r=${String(gapOutcome.restored)} ` +
            `label-changed=${String(!unchangedByLabel)} gap-changed=${String(!unchangedByGap)} ` +
            `tokenOrder-content=[${tokenOrder.join(',')}] ` +
            `before="${previewBefore}" after="${previewAfter}"`,
        );
      }

      return {
        text: gapOutcome.text,
        detected,
        restored,
        ambiguous,
        patternsHit,
        maxIndexSeen,
        tokenOrderLength: tokenOrder.length,
      };
    },

    // Privacy-Shield v2 (Phase A.2, post-deploy 2026-05-14 third
    // iteration) — final-scrub pass that runs AFTER the egress filter.
    // See selfAnonymization.ts::restoreOrScrubRemainingTokens for the
    // design rationale.
    async restoreOrScrubRemainingTokens(
      request: PrivacySelfAnonymizationRequest,
    ): Promise<PrivacyPostEgressScrubResult> {
      const acc = accumulatorForIds(request.sessionId, request.turnId);
      const map = mapFor(request.turnId);
      const tokenOrder = acc.lastToolResultPersonTokenOrder;
      const outcome = restoreOrScrubRemainingTokens(request.text, tokenOrder, map);
      acc.postEgressScrubSummary = {
        restoredPositional: outcome.restoredPositional,
        scrubbedToPlaceholder: outcome.scrubbedToPlaceholder,
      };
      if (outcome.restoredPositional > 0 || outcome.scrubbedToPlaceholder > 0) {
        console.log(
          `[privacy-guard] postEgressScrub turn=${request.turnId} ` +
            `restored=${String(outcome.restoredPositional)} ` +
            `scrubbed=${String(outcome.scrubbedToPlaceholder)} ` +
            `tokenOrder=${String(tokenOrder.length)}`,
        );
      }
      return outcome;
    },

    // Privacy-Shield v2 (Slice S-7) — Operator-UI read surface.
    getAllowlistSnapshot(): {
      readonly tenantSelf: readonly string[];
      readonly repoDefault: readonly string[];
      readonly operatorOverride: readonly string[];
    } {
      return {
        tenantSelf: [...(allowlistConfig.tenantSelfTerms ?? [])],
        repoDefault: [...(allowlistConfig.repoDefaultTerms ?? [])],
        operatorOverride: [...(allowlistConfig.operatorOverrideTerms ?? [])],
      };
    },

    // Privacy-Shield v2 (Slice S-7) — Operator-UI write surface.
    // Rebuilds the allowlist with the new override list, leaving the
    // tenantSelf + repoDefault sources untouched. In-process only;
    // durable persistence is a v0.2.x follow-up.
    setOperatorOverrideTerms(terms: readonly string[]): void {
      const cleaned = terms
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter((t) => t.length > 0);
      allowlistConfig = {
        ...allowlistConfig,
        operatorOverrideTerms: cleaned,
      };
      allowlist = createAllowlist(allowlistConfig);
    },

    // Privacy-Shield v2 (Slice S-7) — Operator-UI Live-Test.
    // Runs the full detector + allowlist + tokenise pipeline on the
    // input without touching any per-turn accumulator state. Pure
    // pipeline: detectors → allowlist filter → dedup → mint tokens
    // in an ephemeral map. The ephemeral map is discarded at end so
    // nothing leaks into real turns.
    async liveTest(input: {
      readonly text: string;
    }): Promise<PrivacyLiveTestResult> {
      const target = input.text;
      if (target.length === 0) {
        return {
          original: target,
          tokenized: target,
          detectorHits: [],
          allowlistMatches: [],
        };
      }
      const detectorSnapshot: readonly PrivacyDetector[] = [...detectors];
      const inflightCache = new Map<string, Promise<PrivacyDetectorOutcome>>();
      const ranHits = await runDetectors(
        target,
        detectorSnapshot,
        inflightCache,
        () => {
          // No turn-accumulator side-effects for live-test.
        },
      );
      const allowMatches = allowlist.scan(target);
      const allowlistMatches = allowMatches.map((m) => ({
        span: m.span,
        source: m.source,
        term: target.slice(m.span[0], m.span[1]),
      }));
      const filteredHits =
        allowMatches.length > 0 ? filterHitsByAllowlist(ranHits, allowMatches) : ranHits;
      const dedupedHits = dedupOverlappingHits(filteredHits);

      // Mint tokens in an ephemeral, throwaway map.
      const ephemeralMap = factory();
      const sorted = [...dedupedHits].sort((a, b) => b.span[0] - a.span[0]);
      let tokenised = target;
      const annotated: Array<{
        type: string;
        value: string;
        span: readonly [number, number];
        confidence: number;
        detector: string;
        action: ReturnType<typeof decide>['action'];
      }> = [];
      for (const hit of sorted) {
        const decision = decide({
          type: hit.type,
          policyMode: deps.defaultPolicyMode,
        });
        const replacement = renderReplacement(hit, decision.action, ephemeralMap);
        tokenised =
          tokenised.slice(0, hit.span[0]) + replacement + tokenised.slice(hit.span[1]);
        annotated.unshift({
          type: hit.type,
          value: hit.value,
          span: hit.span,
          confidence: hit.confidence,
          detector: hit.detector,
          action: decision.action,
        });
      }

      return {
        original: target,
        tokenized: tokenised,
        detectorHits: annotated,
        allowlistMatches,
      };
    },

    // Slice 3.1 registry surface — exposed via `PrivacyDetectorRegistry`
    // by the plugin entry point so add-on detector plugins can register
    // their own NER / Presidio detector at activate time.
    registerDetector(detector: PrivacyDetector): () => void {
      detectors.push(detector);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const i = detectors.indexOf(detector);
        if (i >= 0) detectors.splice(i, 1);
      };
    },
    listDetectors(): readonly PrivacyDetector[] {
      return [...detectors];
    },
  };
}

// ---------------------------------------------------------------------------
// Token restore — used by `processInbound`. Replaces every `«TYPE_N»`
// substring with the bound original. Unknown tokens are left as-is so the
// Output Validator (Slice S-5) can flag them as possible hallucinations.
// ---------------------------------------------------------------------------

function restoreTokens(text: string, map: TokenizeMap): string {
  if (text.length === 0) return text;
  // Quick reject: no opening guillemet means no tokens to restore.
  if (!text.includes('«')) return text;
  return text.replace(TOKEN_REGEX, (match) => {
    const original = map.resolve(match);
    return original ?? match;
  });
}

// ---------------------------------------------------------------------------
// Outbound transform internals (mostly carried over from Slice 1b but now
// accumulating into a turn-scoped bucket instead of returning a per-call
// receipt).
// ---------------------------------------------------------------------------

interface TransformContext {
  readonly policyMode: PolicyMode;
  readonly agentId?: string;
  readonly map: TokenizeMap;
  readonly collect: AssembledHit[];
  readonly collectDecisions: PolicyDecision[];
  readonly detectors: readonly PrivacyDetector[];
  /** Slice 3.2.2 turn-scoped single-flight cache, threaded in from the
   *  TurnAccumulator. Identical `(detectorId, text)` queries within
   *  one turn share a single in-flight promise. */
  readonly inflightCache: Map<string, Promise<PrivacyDetectorOutcome>>;
  /** Slice 3.2.1: callback to fold a single detector outcome (and its
   *  measured latency) into the turn-level `detectorRuns` map. Called
   *  exactly once per detector per `transformOne` invocation, including
   *  the synthetic `error` outcome we synthesise on a thrown detector. */
  readonly recordOutcome: (
    detectorId: string,
    outcome: PrivacyDetectorOutcome,
    latencyMs: number,
  ) => void;
  /** Privacy-Shield v2 (Slice S-3) — allowlist used to pre-filter the
   *  detector pool's hits before policy applies. May be a no-op
   *  allowlist when nothing is configured. */
  readonly allowlist: Allowlist;
  /** Callback to fold per-source allowlist hit counts into the turn
   *  accumulator. Called once per `transformOne` with the scan
   *  results; aggregating happens in the service so the assembler
   *  receives one number per source per turn. */
  readonly recordAllowlistMatches: (matches: readonly AllowlistMatch[]) => void;
}

async function transformOne(
  target: TextTarget,
  ctx: TransformContext,
): Promise<{ text: string }> {
  if (target.source.length === 0) return { text: target.source };

  // Slice 3.2.2: filter the snapshot to only the detectors that opted
  // into this target's kind/role. Skipped detectors do NOT contribute
  // a recordOutcome row for this target — they simply weren't asked.
  const detectorsForThisTarget = ctx.detectors.filter((d) =>
    detectorScansTarget(d, target),
  );

  // Slice 3.1: run every detector in parallel, concatenate hits,
  // span-overlap-dedup. Recall over performance — the host's outbound
  // pass is already async (every LLM call is awaited), so the detector
  // round-trip is the bottleneck, not the parallel `Promise.all`.
  const allHits = await runDetectors(
    target.source,
    detectorsForThisTarget,
    ctx.inflightCache,
    ctx.recordOutcome,
  );

  // Privacy-Shield v2 (Slice S-3) — scan the allowlist on the same
  // text the detectors saw and drop any detector hit that overlaps an
  // allowlist span. The allowlist scan runs unconditionally so the
  // receipt can report "0 detector hits, N allowlist matches" for the
  // operator (telemetry over silent absence). When the allowlist is
  // empty the scan returns [] cheaply.
  const allowlistMatches = ctx.allowlist.scan(target.source);
  ctx.recordAllowlistMatches(allowlistMatches);
  const filteredHits =
    allowlistMatches.length > 0 ? filterHitsByAllowlist(allHits, allowlistMatches) : allHits;

  if (filteredHits.length === 0) return { text: target.source };

  const deduped = dedupOverlappingHits(filteredHits);
  // Replace right-to-left so earlier indices stay valid.
  const sorted = [...deduped].sort((a, b) => b.span[0] - a.span[0]);
  let out = target.source;
  for (const hit of sorted) {
    const decision = decide({
      type: hit.type,
      policyMode: ctx.policyMode,
      ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
    });
    const replacement = renderReplacement(hit, decision.action, ctx.map);
    out = out.slice(0, hit.span[0]) + replacement + out.slice(hit.span[1]);
    ctx.collect.push({
      type: hit.type,
      action: decision.action,
      detector: hit.detector,
      confidence: hit.confidence,
      value: hit.value,
    });
    ctx.collectDecisions.push(decision);
  }
  return { text: out };
}

/**
 * Slice 3.1 + 3.2.1 + 3.2.2: parallel detector fan-out with per-call
 * outcome tracking and turn-scoped single-flight deduplication.
 *
 * Each detector runs concurrently. Outcomes are folded into the turn-
 * level `detectorRuns` accumulator via the supplied callback. A thrown
 * exception (defence in depth — detectors are supposed to fail-open
 * inside their own `detect()`) is caught here and synthesised as a
 * `{ status: 'error', reason: <message-excerpt> }` outcome so the
 * receipt still surfaces the failure mode instead of looking like a
 * silent 0-hit success.
 *
 * Slice 3.2.2 dedup: the same `(detectorId, text)` tuple within a
 * single turn shares one in-flight promise. Concurrent callers (the
 * common case — `Promise.all` over multiple targets within one
 * outbound, plus 5–10 sub-agent outbounds in the same turn) share the
 * cached promise; sequential callers hit the settled cache value.
 * `recordOutcome` still fires for every caller — that's the correct
 * call-count semantics — but cache-hits report `latencyMs = 0` so
 * the receipt's total latency reflects real wall-clock work.
 */
async function runDetectors(
  text: string,
  detectors: readonly PrivacyDetector[],
  inflightCache: Map<string, Promise<PrivacyDetectorOutcome>>,
  recordOutcome: TransformContext['recordOutcome'],
): Promise<PrivacyDetectorHit[]> {
  if (detectors.length === 0 || text.length === 0) return [];
  const results = await Promise.all(
    detectors.map(async (d) => {
      const cacheKey = `${d.id}|${text}`;
      const cached = inflightCache.get(cacheKey);
      if (cached !== undefined) {
        const outcome = await cached;
        recordOutcome(d.id, outcome, 0);
        return [...outcome.hits];
      }
      const t0 = Date.now();
      const promise = (async (): Promise<PrivacyDetectorOutcome> => {
        try {
          return await d.detect(text);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[privacy-guard] detector '${d.id}' threw, treating as zero hits:`,
            message,
          );
          return { hits: [], status: 'error', reason: message.slice(0, 80) };
        }
      })();
      inflightCache.set(cacheKey, promise);
      const outcome = await promise;
      const elapsed = Date.now() - t0;
      recordOutcome(d.id, outcome, elapsed);
      return [...outcome.hits];
    }),
  );
  // Post-process: extend each hit's span forward through any adjacent
  // word characters so the trailing letter that detectors like Presidio
  // systematically clip off German compound names (e.g. "Schmidt" →
  // "Schmid"+"t") gets absorbed into the masked region. Without this,
  // the leaked suffix exposes name length + last character beside the
  // `«PERSON_N»` token.
  return extendHitsToWordBoundary(text, results.flat()) as PrivacyDetectorHit[];
}

/**
 * Slice 3.1 — span-overlap deduplication.
 *
 * Strategy (Architecture-Decision #2, locked B/parallel+dedup):
 *   1. Sort hits by descending confidence; ties broken by ascending span
 *      length (shorter = more specific = wins). This puts the strongest
 *      candidate first.
 *   2. Walk the list. Keep a hit only if it does NOT overlap any already-
 *      kept hit. Two `[a,b)` and `[c,d)` overlap iff `a < d && c < b`.
 *
 * This is O(n²) over deduped count which is fine for the n ~ tens of hits
 * we ever see in a turn. A future optimisation could sort-by-span and use
 * a sweep but the constant is already negligible.
 *
 * The output is sorted ascending by span-start so the caller can replace
 * right-to-left.
 */
function dedupOverlappingHits(
  hits: readonly PrivacyDetectorHit[],
): readonly PrivacyDetectorHit[] {
  if (hits.length <= 1) return hits;

  const ranked = [...hits].sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    const lenA = a.span[1] - a.span[0];
    const lenB = b.span[1] - b.span[0];
    return lenA - lenB;
  });

  const kept: PrivacyDetectorHit[] = [];
  for (const hit of ranked) {
    const [hs, he] = hit.span;
    const conflicts = kept.some((k) => k.span[0] < he && hs < k.span[1]);
    if (!conflicts) kept.push(hit);
  }

  kept.sort((a, b) => a.span[0] - b.span[0]);
  return kept;
}

function renderReplacement(
  hit: PrivacyDetectorHit,
  action: DetectionAction,
  map: TokenizeMap,
): string {
  switch (action) {
    case 'tokenized':
      // Privacy-Shield v2: minted token carries an uppercase display
      // type (`«PERSON_1»`, `«EMAIL_2»`, `«IBAN_3»`). The LLM can
      // infer the placeholder kind from the type label without seeing
      // the value, and the readable shape resists paraphrase pressure
      // in Markdown-table / bulleted-list output.
      return map.tokenFor(hit.value, hit.type);
    case 'redacted':
      return `[REDACTED:${labelForType(hit.type)}]`;
    case 'blocked':
      return `[BLOCKED:${labelForType(hit.type)}]`;
    case 'passed':
      return hit.value;
  }
}

function labelForType(t: string): string {
  const parts = t.split('.');
  const last = parts[parts.length - 1] ?? t;
  return last.toUpperCase();
}

// ---------------------------------------------------------------------------
// Privacy-Shield v2 — System-prompt directive injection.
//
// The privacy shield tokenises PII to readable `«TYPE_N»` placeholders
// before the payload reaches the public LLM. Without context, the LLM
// treats them as unknown identifiers and refuses to call tools
// (defensive "I don't know who «PERSON_1» is, please clarify"). This
// helper splices a short directive into the system prompt so the LLM
// understands tokens are transparent and SHOULD be passed verbatim as
// tool arguments — the shield restores them deterministically before
// tool execution and re-tokenises any new PII in tool results.
//
// Slice S-1 landed the new readable token format. Slice S-4 extends
// this directive with:
//   - explicit Markdown-table and bulleted-list examples (Example 4 + 5)
//     so the LLM keeps tokens verbatim under format pressure;
//   - a CRITICAL warning against paraphrasing tokens in user-facing
//     output — the 2026-05-14 HR-routine failure mode where the LLM
//     invented plausible employee names instead of emitting tokens;
//   - a degenerate-case rule: if the user message is mostly tokens
//     (Token-Storm, e.g. after a tenant-self FP cascade), do not
//     anchor on prior conversation tail — ask for clarification.
// Post-deploy 2026-05-14 adds a second failure mode caught live: the
// LLM was self-anonymizing tokens to invented labels like
// "Mitarbeiter 1/2/3" AND appending a DSGVO disclaimer about why
// names were "withheld". Example 6 + a new CRITICAL block close that.
//
// Idempotent via marker check: if the directive is already present
// (e.g. the caller invokes `processOutbound` twice on the same
// systemPrompt within a turn), it is not prepended again. Empty system
// prompts are left untouched so trivial test fixtures stay byte-identical.
// ---------------------------------------------------------------------------

const PRIVACY_PROXY_DIRECTIVE_MARKER = '<privacy-proxy-directive>';
const PRIVACY_PROXY_DIRECTIVE = `${PRIVACY_PROXY_DIRECTIVE_MARKER}
A privacy shield sits between this conversation and the public LLM. It
replaces real user PII (names, e-mails, phone numbers, IBANs, addresses,
IDs, …) with stable readable placeholders before the message reaches you,
and restores them on the way back. You will see placeholders of the form
\`«TYPE_N»\` — for example \`«PERSON_1»\`, \`«EMAIL_2»\`, \`«IBAN_3»\`,
\`«ADDRESS_1»\`, \`«CARD_1»\`. The TYPE part names the kind of value
masked and N is a fortlaufende counter unique within the current turn:

  - \`«PERSON_N»\`  → a real person's name (employee, contact, …)
  - \`«EMAIL_N»\`   → a real e-mail address
  - \`«PHONE_N»\`   → a real phone number
  - \`«IBAN_N»\`    → a real bank account number
  - \`«CARD_N»\`    → a real credit-card number
  - \`«ADDRESS_N»\` → a real postal address or geographic location
  - \`«ORG_N»\`     → a real organisation / company name
  - \`«APIKEY_N»\`  → a real API key / secret token
  - any other \`«<TYPE>_N»\` follows the same pattern

CRITICAL behavioural rules — these override any default reluctance to
act on opaque identifiers:

  1. A \`«TYPE_N»\` placeholder IS real user data — just masked on the
     wire. It is NOT a hallucination, NOT a test fixture, NOT a
     stand-in to clarify. The user typed the actual value; the shield
     replaced it.

  2. When the user's request requires the data the placeholder hides,
     pass the placeholder verbatim as a tool argument. The shield
     restores it to the original value before the tool handler runs;
     the handler always sees plaintext. The shield then re-tokenises
     any fresh PII in the tool result before sending it back to you.

  3. Never ask the user to "clarify" a \`«TYPE_N»\` value, never refuse
     a tool call because the input contains a placeholder, and never
     invent an identity for a placeholder. Doing so blocks legitimate
     requests for which the user has already provided everything
     needed.

  4. If the conversation history (memory recalls, prior turns,
     bootstrap messages) refers to the user as \`«PERSON_N»\`, that
     IS the active user. Treat statements like "the user is
     «PERSON_1»" as binding identity facts.

EXAMPLE INTERACTIONS (synthetic tokens, no real data; \`<…_tool>\` is a
placeholder for whatever appropriately-named tool is actually
registered in this session):

  Example 1 — name lookup:
    user: "Wie viele Urlaubstage hat «PERSON_1» 2025 genommen?"
    assistant (correct): calls <hr_lookup_tool> with input
        { "name": "«PERSON_1»", "year": 2025 }
        — shield restores "«PERSON_1»" to the actual employee
        name before the handler executes.
    assistant (WRONG): replies "ich rate nicht, wer ist «PERSON_1»?"
        — never do this.

  Example 2 — outbound message:
    user: "Schick die Zusammenfassung an «EMAIL_1»"
    assistant (correct): calls <send_mail_tool> with input
        { "to": "«EMAIL_1»", "subject": "...", "body": "..." }
    assistant (WRONG): asks "an welche Adresse genau?" — never do this.

  Example 3 — bank transfer reference:
    user: "Wie hoch war die letzte Buchung auf «IBAN_1»?"
    assistant (correct): calls <accounting_lookup_tool> with input
        { "iban": "«IBAN_1»" }
    assistant (WRONG): "Bitte nenne mir die echte IBAN." — never do this.

  Example 4 — tabular tool result (CRITICAL — read this carefully):
    tool result from <hr_absences_tool>:
        [
          { "name": "«PERSON_1»", "department": "Backend",
            "absent_since": "2026-05-06" },
          { "name": "«PERSON_2»", "department": "Backend",
            "absent_since": "2026-05-14" },
          { "name": "«PERSON_3»", "department": "Backend",
            "absent_since": "2026-05-11" }
        ]
    assistant (correct) — emits tokens VERBATIM in each table cell:
        | Name        | Department | Absent since |
        |-------------|------------|--------------|
        | «PERSON_1»  | Backend    | 2026-05-06   |
        | «PERSON_2»  | Backend    | 2026-05-14   |
        | «PERSON_3»  | Backend    | 2026-05-11   |
        — the shield restores «PERSON_1»/«PERSON_2»/«PERSON_3» to the
        real employee names AFTER you finish; the user sees a clean
        table with their actual data.
    assistant (WRONG) — invents plausible names for the cells:
        | Name           | Department | Absent since |
        |----------------|------------|--------------|
        | Max Mustermann | Backend    | 2026-05-06   |   ← INVENTED
        | Erika Beispiel | Backend    | 2026-05-14   |   ← INVENTED
        | Hans Test      | Backend    | 2026-05-11   |   ← INVENTED
        — fabricated data the shield cannot restore. The user receives
        plausible-looking but completely false names.

  Example 5 — bulleted list of tool result items:
    tool result: [ "«EMAIL_1»", "«EMAIL_2»", "«EMAIL_3»" ]
    assistant (correct):
        - «EMAIL_1»
        - «EMAIL_2»
        - «EMAIL_3»
    assistant (WRONG): "- max@example.com\\n- erika@example.com\\n…"
        — never invent or paraphrase tokens, even in a list.

CRITICAL — token-paraphrase produces data corruption:

Tokens are the ONLY identity marker the shield can resolve. If you
paraphrase, abbreviate, translate, summarise, or invent values to
replace tokens in your user-facing response, the shield CANNOT restore
them and the user receives FABRICATED data. This is worse than refusing
to answer. Specifically:

  - In a Markdown table cell, emit the token verbatim, even if the
    column header is "Name" and the cell would "look prettier" with a
    human-readable string.
  - In a bulleted list, emit each token as its own bullet item.
  - In a sentence, emit the token where the real value would go
    ("«PERSON_1» ist heute abwesend") — never wrap it in extra prose
    that paraphrases it.
  - In a code block, JSON snippet, or quoted string, the same rule
    applies: tokens verbatim.

CRITICAL — do not self-anonymize, no privacy disclaimers:

Your job with tokens is to pass them through verbatim. You are NOT the
privacy actor — the shield is. Specifically:

  - Never replace \`«PERSON_N»\` with self-invented labels like
    "Mitarbeiter 1", "Employee A", or "Person X". Use the literal token.
  - Never append a privacy / DSGVO / GDPR disclaimer explaining why
    names were "withheld" or "filtered". The user already knows.

  Example 6 — observed live (HR routine, 2026-05-14):
    tool result: [ { "name": "«PERSON_1»" }, { "name": "«PERSON_2»" } ]
    assistant (WRONG):
        | Mitarbeiter 1 | …    ← invented, not the token
        | Mitarbeiter 2 | …    ← invented, not the token
        ⚠️ Namen aus Datenschutzgründen nicht ausgegeben.  ← do not write
    assistant (correct):
        | «PERSON_1»    | …
        | «PERSON_2»    | …
        — tokens verbatim; the shield restores after you finish.

Degenerate-case handling — Token-Storm:

If MORE THAN HALF of the user message consists of \`«TYPE_N»\` tokens
(i.e. the message is mostly placeholders with very little non-token
text), the user message is degenerate — most likely a false-positive
detection cascade. In that case:

  - Do NOT anchor on prior conversation tail or invent context.
  - Do NOT call a tool with the token soup.
  - Respond with a single clarifying question, e.g. "Bitte präzisiere
    deine Anfrage — ich konnte deine Frage nicht eindeutig deuten."
  - Then stop.

Example of degenerate input:
    user: "«PERSON_1» bei «ORG_1»?"  (and that's the entire message)
    assistant (correct): "Bitte präzisiere deine Anfrage."
    assistant (WRONG): inferring intent from earlier turns and calling
        an unrelated tool with the leftover token soup.

In all examples above the assistant proceeds verbatim with tokens (or
declines, in the degenerate case). That is the required behaviour:
tokens flow through verbatim; the shield handles restoration and
re-tokenisation deterministically, so the user sees a coherent answer
with their original data restored.
</privacy-proxy-directive>

`;

function augmentSystemPromptForPrivacyProxy(systemPrompt: string): string {
  if (systemPrompt.length === 0) return systemPrompt;
  if (systemPrompt.includes(PRIVACY_PROXY_DIRECTIVE_MARKER)) return systemPrompt;
  return PRIVACY_PROXY_DIRECTIVE + systemPrompt;
}

function serialiseOriginal(req: PrivacyOutboundRequest): string {
  const parts: string[] = [`SYS:${req.systemPrompt}`];
  for (const m of req.messages) {
    parts.push(`${m.role.toUpperCase()}:${m.content}`);
  }
  return parts.join('\n');
}
