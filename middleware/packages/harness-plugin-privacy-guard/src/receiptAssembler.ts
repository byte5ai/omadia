/**
 * ReceiptAssembler — turns a list of decided-on hits into a PII-free
 * `PrivacyReceipt`.
 *
 * The assembler is the single place where internal detector data
 * (`value`, `span`, raw token) is stripped out. Everything in the
 * receipt is aggregate (`count`, `confidenceMin`, `latencyMs`) or
 * non-sensitive metadata (detector id, action label, audit hash). If
 * a future contributor needs to surface span info to the UI, they
 * have to add it to the audit pipeline, not here.
 *
 * Slice 3.2.1 exception: when the privacy-guard plugin runs with
 * `debug_show_values=on`, the assembler ALSO emits the matched raw
 * substrings (`tokenized` only — never `redacted`/`blocked`) so the
 * web UI can show what was actually filtered. Output carries a
 * top-level `debug: true` flag so channel renderers can paint a clear
 * "DEBUG-MODUS" warning.
 */

import { createHash, randomBytes } from 'node:crypto';

import type {
  DetectionAction,
  PolicyMode,
  PrivacyDetection,
  PrivacyDetectorRun,
  PrivacyReceipt,
  Routing,
} from '@omadia/plugin-api';

/**
 * Slice 3.1 widens `type` to free-form string so add-on detectors
 * (Slice 3.2 NER, Slice 3.4 Presidio) can emit `pii.name`,
 * `business.contract_clause`, etc. without a contract change.
 *
 * Slice 3.2.1 adds `value` so the assembler can emit `values` arrays
 * when `debug_show_values=on`. The field is internal — never present
 * in the receipt unless explicitly opted in via the assemble input.
 */
export interface AssembledHit {
  readonly type: string;
  readonly action: DetectionAction;
  readonly detector: string;
  readonly confidence: number;
  readonly value: string;
}

export interface AssembleInput {
  readonly hits: ReadonlyArray<AssembledHit>;
  readonly policyMode: PolicyMode;
  readonly routing: Routing;
  readonly routingReason?: string;
  readonly latencyMs: number;
  /** Canonicalised serialisation of the original payload (system + messages
   *  joined with newline separators). Hashed; never stored verbatim. */
  readonly originalPayload: string;
  /** Slice 3.2.1: per-detector run summary aggregated across the turn.
   *  See plugin-api/PrivacyDetectorRun. Always present (may be empty).
   *  The receipt renders this as a "Detektoren" section so the operator
   *  can spot a `skipped`/`timeout`/`error` detector even when the
   *  detection-list is empty. */
  readonly detectorRuns: ReadonlyArray<PrivacyDetectorRun>;
  /** Slice 3.2.1 debug-mode toggle. When `true`, the assembler emits
   *  the matched raw substrings inside `detections[*].values` for
   *  `tokenized` actions (NEVER for `redacted`/`blocked` — those are
   *  intentionally destructive). The receipt also carries a
   *  `debug: true` top-level flag so channel renderers can warn. */
  readonly debugShowValues?: boolean;
  /** Slice 2.2 — optional tool-roundtrip telemetry. When at least one
   *  `processToolInput` / `processToolResult` ran in the turn, the
   *  service passes the aggregated counters here and the receipt
   *  surfaces a `toolRoundtrip` section. Omit (or pass undefined) when
   *  no tool roundtrip happened — the field stays absent so non-tool
   *  turns keep the existing receipt shape. */
  readonly toolRoundtrip?: {
    readonly argsRestored: number;
    readonly resultsTokenized: number;
    readonly callCount: number;
  };
}

export function assembleReceipt(input: AssembleInput): PrivacyReceipt {
  const detections = aggregate(input.hits, input.debugShowValues === true);
  const auditHash = createHash('sha256').update(input.originalPayload).digest('hex');
  return {
    receiptId: mintReceiptId(),
    policyMode: input.policyMode,
    routing: input.routing,
    ...(input.routingReason !== undefined ? { routingReason: input.routingReason } : {}),
    detections,
    latencyMs: input.latencyMs,
    auditHash,
    detectorRuns: input.detectorRuns,
    ...(input.debugShowValues === true ? { debug: true } : {}),
    ...(input.toolRoundtrip !== undefined && input.toolRoundtrip.callCount > 0
      ? { toolRoundtrip: input.toolRoundtrip }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface BucketKey {
  readonly type: string;
  readonly action: DetectionAction;
  readonly detector: string;
}

interface BucketAccum {
  readonly key: BucketKey;
  count: number;
  confidenceMin: number;
  /** Slice 3.2.1 debug bucket: distinct matched values for tokenized
   *  actions. Set semantics — same value detected twice contributes
   *  one entry. Empty when debug-mode is off OR action !== tokenized. */
  readonly values: Set<string>;
}

function aggregate(
  hits: ReadonlyArray<AssembledHit>,
  debugShowValues: boolean,
): readonly PrivacyDetection[] {
  // Group by (type, action, detector). Same type with two different actions
  // means two separate detection rows in the receipt — that is intentional
  // so the UI can show "email ×2 → tokenised, email ×1 → blocked" if the
  // policy ever fans out.
  const buckets = new Map<string, BucketAccum>();
  for (const hit of hits) {
    const key: BucketKey = { type: hit.type, action: hit.action, detector: hit.detector };
    const k = `${key.type}|${key.action}|${key.detector}`;
    const existing = buckets.get(k);
    if (existing) {
      existing.count += 1;
      if (hit.confidence < existing.confidenceMin) existing.confidenceMin = hit.confidence;
      // Only retain the value when debug is on AND the action is
      // tokenized. redacted/blocked are intentionally destructive —
      // surfacing the raw value would defeat the purpose.
      if (debugShowValues && hit.action === 'tokenized') {
        existing.values.add(hit.value);
      }
    } else {
      const accum: BucketAccum = {
        key,
        count: 1,
        confidenceMin: hit.confidence,
        values: new Set<string>(),
      };
      if (debugShowValues && hit.action === 'tokenized') {
        accum.values.add(hit.value);
      }
      buckets.set(k, accum);
    }
  }

  return [...buckets.values()].map((b) => {
    const det: PrivacyDetection = {
      type: b.key.type,
      count: b.count,
      action: b.key.action,
      detector: b.key.detector,
      confidenceMin: b.confidenceMin,
      ...(b.values.size > 0 ? { values: [...b.values] } : {}),
    };
    return det;
  });
}

function mintReceiptId(): string {
  const today = new Date().toISOString().slice(0, 10);
  const random = randomBytes(4).toString('hex');
  return `prv_${today}_${random}`;
}
