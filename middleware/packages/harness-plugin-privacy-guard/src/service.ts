/**
 * Service factory for `privacy.redact@1` (Slice 2.1).
 *
 * Pure function — takes config and returns a stateful `PrivacyGuardService`
 * that the plugin's `activate` publishes via `ctx.services.provide`. Kept
 * as a free function (not a class) so tests can construct without a
 * `PluginContext`.
 *
 * State held by the returned service:
 *   - `Map<sessionId, TokenizeMap>` — session-scoped token bindings. Same
 *     value yields the same token across all turns of one conversation,
 *     so the LLM can keep referencing it coherently ("the same email as
 *     before"). The map is currently in-memory only; Slice 2.4 adds AES
 *     encryption + a 15-min idle TTL + explicit destroy on session end.
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
  PrivacyGuardService,
  PrivacyInboundRequest,
  PrivacyInboundResult,
  PrivacyOutboundMessage,
  PrivacyOutboundRequest,
  PrivacyOutboundResult,
  PrivacyReceipt,
  PrivacyToolInputRequest,
  PrivacyToolInputResult,
  PrivacyToolResultRequest,
  PrivacyToolResultResult,
  Routing,
} from '@omadia/plugin-api';

import { assembleReceipt, type AssembledHit } from './receiptAssembler.js';
import { decide, deriveRouting, type PolicyDecision } from './policyEngine.js';
import { createRegexDetector } from './regexDetector.js';
import { TOKEN_REGEX, createTokenizeMap, type TokenizeMap } from './tokenizeMap.js';

export interface PrivacyGuardServiceDeps {
  /** Default policy mode applied when the request does not pin one. */
  readonly defaultPolicyMode: PolicyMode;
  /** Override for tests; production should let the service mint its own
   *  per-session map via `createTokenizeMap()`. */
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
  const sessionMaps = new Map<string, TokenizeMap>();
  const turnAccumulators = new Map<string, TurnAccumulator>();
  // Slice 3.1: detector list. Empty seed → bundle the regex detector as
  // default so existing single-detector behaviour holds without config.
  // Detectors registered after the service is built (Slice 3.2 Ollama
  // add-on) append here; the next outbound pass picks them up.
  const detectors: PrivacyDetector[] =
    deps.detectors && deps.detectors.length > 0
      ? [...deps.detectors]
      : [createRegexDetector()];

  function mapFor(sessionId: string): TokenizeMap {
    let m = sessionMaps.get(sessionId);
    if (m === undefined) {
      m = factory();
      sessionMaps.set(sessionId, m);
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

  return {
    async processOutbound(
      request: PrivacyOutboundRequest,
    ): Promise<PrivacyOutboundResult> {
      const map = mapFor(request.sessionId);
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
      const map = sessionMaps.get(request.sessionId);
      if (map === undefined) {
        // No outbound was ever processed for this session — nothing to
        // restore. Pass-through.
        return { text: request.text };
      }
      return { text: restoreTokens(request.text, map) };
    },

    async finalizeTurn(turnId: string): Promise<PrivacyReceipt | undefined> {
      const acc = turnAccumulators.get(turnId);
      if (acc === undefined) return undefined;
      turnAccumulators.delete(turnId);

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
      });
      return receipt;
    },

    async processToolInput(
      request: PrivacyToolInputRequest,
    ): Promise<PrivacyToolInputResult> {
      const acc = accumulatorForIds(request.sessionId, request.turnId);
      acc.toolRoundtripCallCount += 1;
      const map = sessionMaps.get(request.sessionId);
      if (map === undefined) {
        // No outbound was ever processed for this session — there are no
        // tokens to restore. Pass-through.
        return { input: request.input, tokensRestored: 0 };
      }
      let restoredCount = 0;
      const walk = (v: unknown): unknown => {
        if (typeof v === 'string') {
          if (!v.includes('tok_')) return v;
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
        map: mapFor(request.sessionId),
        collect: acc.hits,
        collectDecisions: localDecisions,
        detectors: detectorSnapshot,
        inflightCache: acc.inflightCache,
        recordOutcome: (id, outcome, latencyMs) =>
          recordOutcome(acc, id, outcome, latencyMs),
      });

      const wasTransformed = transformed.text !== request.text;
      if (wasTransformed) {
        acc.toolRoundtripResultsTokenized += 1;
      }

      // Tool result is part of the turn's outbound surface back to the
      // LLM — feed it into the audit-hash chunks like processOutbound
      // does for system + messages so the auditHash covers the full
      // payload that crossed the wire.
      acc.originalChunks.push(`TOOL_RESULT(${request.toolName}):${request.text}`);

      return { text: transformed.text, transformed: wasTransformed };
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
// Token restore — used by `processInbound`. Replaces every `tok_<hex>`
// substring with the bound original. Unknown tokens are left as-is so the
// caller can decide what to do (Slice 2.3 hallucination flagging will
// re-scan from here).
// ---------------------------------------------------------------------------

function restoreTokens(text: string, map: TokenizeMap): string {
  if (text.length === 0) return text;
  // Quick reject: no `tok_` substring at all means nothing to do.
  if (!text.includes('tok_')) return text;
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
  if (allHits.length === 0) return { text: target.source };

  const deduped = dedupOverlappingHits(allHits);
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
  return results.flat();
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
      // Slice 2.2: pass the detector hit type as a typeHint so the
      // minted token carries a `_<type>` suffix (`tok_a1b2c3d4_name`,
      // `tok_e5f6g7h8_email`, …). The LLM can infer the placeholder
      // kind from the suffix without seeing the value.
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
// Slice 2.2 — System-prompt directive injection.
//
// The privacy proxy tokenises PII in user inputs to `tok_<hex>` placeholders
// before the payload reaches the public LLM. Without context, the LLM treats
// these tokens as unknown identifiers and refuses to call tools (defensive
// "I don't know who tok_a3f9 is, please clarify"). This helper splices a
// short directive into the system prompt so the LLM understands tokens are
// transparent and SHOULD be passed verbatim as tool arguments — the proxy
// restores them deterministically before tool execution and re-tokenises any
// new PII in tool results (Slice 2.2 Part B).
//
// Idempotent via marker check: if the directive is already present (e.g. the
// caller invokes `processOutbound` twice on the same systemPrompt within a
// turn), it is not prepended again. Empty system prompts are left untouched
// so trivial test fixtures stay byte-identical.
// ---------------------------------------------------------------------------

const PRIVACY_PROXY_DIRECTIVE_MARKER = '<privacy-proxy-directive>';
const PRIVACY_PROXY_DIRECTIVE = `${PRIVACY_PROXY_DIRECTIVE_MARKER}
A privacy proxy sits between this conversation and the public LLM. It
replaces real user PII (names, e-mails, phone numbers, IBANs, addresses,
IDs, …) with stable opaque placeholders before the message reaches you,
and restores them on the way back. You will see placeholders of the form
\`tok_<8 hex>_<type>\` — for example \`tok_a1b2c3d4_name\`,
\`tok_e5f6a7b8_email\`, \`tok_12345678_iban\`. The type suffix names
what kind of value is hidden:

  - \`_name\`         → a real person's name (employee, contact, …)
  - \`_email\`        → a real e-mail address
  - \`_phone\`        → a real phone number
  - \`_iban\`         → a real bank account number
  - \`_credit_card\`  → a real credit-card number
  - \`_address\`      → a real postal address
  - \`_location\`     → a real geographic location
  - \`_organization\` → a real organisation / company name
  - any other \`_<type>\` follows the same pattern

CRITICAL behavioural rules — these override any default reluctance to
act on opaque identifiers:

  1. A \`tok_…_<type>\` placeholder IS real user data — just masked on
     the wire. It is NOT a hallucination, NOT a test fixture, NOT a
     stand-in to clarify. The user typed the actual value; the proxy
     replaced it.

  2. When the user's request requires the data the placeholder hides,
     pass the placeholder verbatim as a tool argument. The proxy
     restores it to the original value before the tool handler runs;
     the handler always sees plaintext. The proxy then re-tokenises
     any fresh PII in the tool result before sending it back to you.

  3. Never ask the user to "clarify" a \`tok_…\` value, never refuse a
     tool call because the input contains a placeholder, and never
     invent an identity for a placeholder. Doing so blocks legitimate
     requests for which the user has already provided everything
     needed.

  4. If the conversation history (memory recalls, prior turns,
     bootstrap messages) refers to the user as \`tok_<hex>_name\`,
     that IS the active user. Treat statements like "the user is
     tok_a1b2c3d4_name" as binding identity facts.

EXAMPLE INTERACTIONS (synthetic tokens, no real data; \`<…_tool>\` is a
placeholder for whatever appropriately-named tool is actually
registered in this session):

  Example 1 — name lookup:
    user: "Wie viele Urlaubstage hat tok_a1b2c3d4_name 2025 genommen?"
    assistant (correct): calls <hr_lookup_tool> with input
        { "name": "tok_a1b2c3d4_name", "year": 2025 }
        — proxy restores "tok_a1b2c3d4_name" to the actual employee
        name before the handler executes.
    assistant (WRONG): replies "ich rate nicht, wer ist tok_a1b2c3d4_name?"
        — never do this.

  Example 2 — outbound message:
    user: "Schick die Zusammenfassung an tok_e5f6a7b8_email"
    assistant (correct): calls <send_mail_tool> with input
        { "to": "tok_e5f6a7b8_email", "subject": "...", "body": "..." }
    assistant (WRONG): asks "an welche Adresse genau?" — never do this.

  Example 3 — bank transfer reference:
    user: "Wie hoch war die letzte Buchung auf tok_12345678_iban?"
    assistant (correct): calls <accounting_lookup_tool> with input
        { "iban": "tok_12345678_iban" }
    assistant (WRONG): "Bitte nenne mir die echte IBAN." — never do this.

In all three examples the assistant proceeds with the tool call. That
is the required behaviour: tokens always flow through to tools verbatim;
the proxy handles restoration and re-tokenisation deterministically, so
the user sees a coherent answer with their original data restored.
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
