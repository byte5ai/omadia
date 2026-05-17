/**
 * Privacy-Shield v2 — Slice S-6 — Egress Filter.
 *
 * Pure helper. The service hosts the per-turn state (token-map +
 * accumulator); this module knows how to walk an array of text slots,
 * fan out the detector pool, distinguish restored PII (already in
 * the turn-map) from spontaneous PII (LLM hallucination or memory
 * leak via verbose tool output), and apply the operator-configured
 * reaction.
 *
 * The egress filter is the LAST detector run before the channel
 * plugin receives the final answer. Where `processOutbound` protects
 * outgoing prompts to the public LLM, the egress filter protects the
 * user — and the audit log — from anything the LLM produced that the
 * shield could not anticipate. Concrete failure modes it catches:
 *
 *   - Hallucinated identities. The LLM emits a plausible name in a
 *     table cell instead of the `«PERSON_N»` placeholder it should
 *     have kept verbatim (HR-routine bug, 2026-05-14). Output
 *     Validator catches paraphrase as a metric; the egress filter
 *     catches the concrete value and can mask it inline.
 *   - Memory-leak via verbose tool result. A tool handler returned
 *     PII in a `metadata.debug_summary` block we never tokenised;
 *     the egress filter re-scans the final assembled answer and
 *     redacts what slipped through.
 */

import type {
  PrivacyDetector,
  PrivacyDetectorHit,
  PrivacyDetectorOutcome,
  PrivacyDetectorRun,
  PrivacyDetectorStatus,
  PrivacyEgressMode,
  PrivacyEgressRequest,
  PrivacyEgressResult,
  PrivacyEgressRouting,
  PrivacyEgressTextResult,
} from '@omadia/plugin-api';

import type { TokenizeMap } from './tokenizeMap.js';
import { extendHitsToWordBoundary } from './spanHelpers.js';
import { filterHitsByAllowlist, type Allowlist } from './allowlist.js';

export interface EgressFilterDeps {
  readonly detectors: readonly PrivacyDetector[];
  readonly map: TokenizeMap;
  readonly defaultMode: PrivacyEgressMode;
  /**
   * Privacy-Shield v2 (post-deploy 2026-05-14) — the inbound pipeline
   * (`transformOne`) suppresses detector hits that overlap an allowlist
   * span; egress must do the same or it re-detects what inbound let
   * through. Asymmetric semantics caused the `Kr«ADDRESS_9»` regression
   * on German section headers ("Krankheit" → ADDRESS via Presidio NER):
   * inbound dropped the hit via the repo-default topic-nouns, egress
   * re-fired and masked the same span. Same `Allowlist` instance the
   * service holds — built once per `activate` from the configured
   * tenantSelf + repoDefault + operatorOverride sources.
   */
  readonly allowlist: Allowlist;
}

interface DetectorRunAccum {
  readonly detector: string;
  status: PrivacyDetectorStatus;
  callCount: number;
  hitCount: number;
  latencyMs: number;
  reason: string | undefined;
}

/** Severity rank shared with the main service. `error > timeout > skipped > ok`. */
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

/**
 * Run every registered detector against `text`, capture per-detector
 * status / latency / hit-count into `runs`, and return the union of
 * hits. Thrown exceptions are caught and surfaced as `status: 'error'`
 * outcomes — never re-thrown. Mirrors `service.runDetectors` but with
 * an egress-local run accumulator (`runs` map) so the receipt sees
 * the egress pass as a separate audit-line and the orchestrator's
 * outbound detector buckets do not get double-counted.
 */
async function runDetectorsForEgress(
  text: string,
  detectors: readonly PrivacyDetector[],
  runs: Map<string, DetectorRunAccum>,
): Promise<PrivacyDetectorHit[]> {
  if (detectors.length === 0 || text.length === 0) return [];
  const results = await Promise.all(
    detectors.map(async (d) => {
      let bucket = runs.get(d.id);
      if (bucket === undefined) {
        bucket = {
          detector: d.id,
          status: 'ok',
          callCount: 0,
          hitCount: 0,
          latencyMs: 0,
          reason: undefined,
        };
        runs.set(d.id, bucket);
      }
      const t0 = Date.now();
      let outcome: PrivacyDetectorOutcome;
      try {
        outcome = await d.detect(text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[privacy-guard] egress detector '${d.id}' threw, treating as zero hits:`,
          message,
        );
        outcome = { hits: [], status: 'error', reason: message.slice(0, 80) };
      }
      const elapsed = Date.now() - t0;
      if (statusRank(outcome.status) > statusRank(bucket.status)) {
        bucket.status = outcome.status;
        bucket.reason = outcome.reason;
      }
      bucket.callCount += 1;
      bucket.hitCount += outcome.hits.length;
      bucket.latencyMs += elapsed;
      return [...outcome.hits];
    }),
  );
  // Same word-boundary extension as the main service.runDetectors —
  // absorbs the 1-char tail Presidio clips off German names so the
  // egress mask covers the entire surface form, not "«PERSON_N»t".
  return extendHitsToWordBoundary(text, results.flat()) as PrivacyDetectorHit[];
}

/**
 * Span-overlap dedup, copied from the service. Identical strategy: keep
 * the highest-confidence hit; shorter / more-specific wins ties. Output
 * is sorted ascending by span-start so callers can replace right-to-left.
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

/**
 * Main entry. Walks `request.texts`, returns a transformed copy plus
 * the aggregate counters needed by the receipt. The caller is
 * responsible for plumbing `result` into the turn accumulator.
 */
export async function runEgressFilter(
  request: PrivacyEgressRequest,
  deps: EgressFilterDeps,
): Promise<PrivacyEgressResult> {
  const mode: PrivacyEgressMode = request.mode ?? deps.defaultMode;
  const runs = new Map<string, DetectorRunAccum>();
  const detectorSnapshot: readonly PrivacyDetector[] = [...deps.detectors];

  // Pre-touch every detector bucket so the receipt always lists the
  // full active-detector set, even when none of them fired on the
  // egress text. Mirrors the `processOutbound` contract — 0 hits is
  // semantic ("scanned, found nothing"), not absence.
  for (const d of detectorSnapshot) {
    if (!runs.has(d.id)) {
      runs.set(d.id, {
        detector: d.id,
        status: 'ok',
        callCount: 0,
        hitCount: 0,
        latencyMs: 0,
        reason: undefined,
      });
    }
  }

  const perSlot: PrivacyEgressTextResult[] = [];
  let totalSpontaneous = 0;
  let totalMasked = 0;
  // `mask` upgrades routing to `masked` once at least one span was
  // rewritten. `block` upgrades routing to `blocked` on the first
  // spontaneous hit and short-circuits further rewriting (the host
  // will replace the whole payload anyway). `mark` leaves routing
  // at `allow` regardless of how many spans fired.
  let blocked = false;
  let anyMasked = false;

  for (const slot of request.texts) {
    if (blocked) {
      // Already decided to block this turn — preserve original texts
      // unchanged so the host's placeholder swap is a single point of
      // truth. We still pass the slot through so the result array
      // stays in lockstep with the request order.
      perSlot.push({
        id: slot.id,
        text: slot.text,
        spontaneousHits: 0,
        maskedCount: 0,
      });
      continue;
    }
    const allHits = await runDetectorsForEgress(slot.text, detectorSnapshot, runs);
    if (allHits.length === 0) {
      perSlot.push({
        id: slot.id,
        text: slot.text,
        spontaneousHits: 0,
        maskedCount: 0,
      });
      continue;
    }
    // Drop hits that overlap an allowlist span BEFORE the turn-map
    // check — otherwise the egress filter re-masks compound words like
    // "Krankheit" that the inbound pipeline correctly let through.
    // Mirrors `service.ts::transformOne` (Slice S-3).
    const allowlistMatches = deps.allowlist.scan(slot.text);
    const allowlistedHits =
      allowlistMatches.length > 0
        ? filterHitsByAllowlist(allHits, allowlistMatches)
        : allHits;
    if (allowlistedHits.length === 0) {
      perSlot.push({
        id: slot.id,
        text: slot.text,
        spontaneousHits: 0,
        maskedCount: 0,
      });
      continue;
    }
    const deduped = dedupOverlappingHits(allowlistedHits);
    // A hit whose value is already in the turn-map is restored PII —
    // the user typed it earlier and the shield put it back together
    // on the inbound side. Anything else is spontaneous.
    const spontaneous: PrivacyDetectorHit[] = [];
    for (const hit of deduped) {
      if (!deps.map.hasOriginalValue(hit.value)) {
        spontaneous.push(hit);
      }
    }
    if (spontaneous.length === 0) {
      perSlot.push({
        id: slot.id,
        text: slot.text,
        spontaneousHits: 0,
        maskedCount: 0,
      });
      continue;
    }

    totalSpontaneous += spontaneous.length;

    if (mode === 'mark') {
      // Operator-only visibility — no text mutation. The receipt still
      // records the hit so the audit log explains why a future
      // turn might escalate to `mask`.
      perSlot.push({
        id: slot.id,
        text: slot.text,
        spontaneousHits: spontaneous.length,
        maskedCount: 0,
      });
      continue;
    }

    if (mode === 'block') {
      // First spontaneous hit wins — short-circuit. The remaining
      // slots are returned as-is below (the `blocked` early-exit
      // branch handles them).
      perSlot.push({
        id: slot.id,
        text: slot.text,
        spontaneousHits: spontaneous.length,
        maskedCount: 0,
      });
      blocked = true;
      continue;
    }

    // mode === 'mask': replace right-to-left so earlier spans stay valid.
    const sorted = [...spontaneous].sort((a, b) => b.span[0] - a.span[0]);
    let out = slot.text;
    let masked = 0;
    for (const hit of sorted) {
      const token = deps.map.tokenFor(hit.value, hit.type);
      out = out.slice(0, hit.span[0]) + token + out.slice(hit.span[1]);
      masked += 1;
    }
    totalMasked += masked;
    if (masked > 0) anyMasked = true;
    perSlot.push({
      id: slot.id,
      text: out,
      spontaneousHits: spontaneous.length,
      maskedCount: masked,
    });
  }

  const routing: PrivacyEgressRouting = blocked
    ? 'blocked'
    : anyMasked
      ? 'masked'
      : 'allow';

  const detectorRuns: PrivacyDetectorRun[] = [...runs.values()].map((b) => ({
    detector: b.detector,
    status: b.status,
    callCount: b.callCount,
    hitCount: b.hitCount,
    latencyMs: b.latencyMs,
    ...(b.reason !== undefined ? { reason: b.reason } : {}),
  }));

  return {
    mode,
    routing,
    texts: perSlot,
    detectorRuns,
    spontaneousHits: totalSpontaneous,
    maskedCount: totalMasked,
  };
}
