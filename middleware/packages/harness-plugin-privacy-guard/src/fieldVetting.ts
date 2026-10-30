/**
 * #1556 follow-up — vet a masked field's buffered value sample with the
 * privacy guard's own detectors, and shape-mask it for the admin preview.
 *
 * Only the verdict leaves: a count, whether an identity shape or deny-list
 * term matched, the C1 name verdict, and the detector TYPES that hit. No
 * value, no span text is returned or logged.
 *
 *   - C0: the baseline identity detector (e-mail, IBAN, phone, address, ID
 *     number; a bare ISO date never counts) on each value.
 *   - The operator's deny-list (custom terms / patterns) on each value.
 *   - C1 (GLiNER sidecar) over the joined sample, when configured. Its
 *     detector runs at the lower near-miss threshold; a span at or above
 *     the normal threshold is a `hit`, any lower one a `near-miss`. Not
 *     configured, or failing ⇒ `unavailable`.
 */

import type { FieldSampleC1Verdict, FieldSampleVerdict, PromptPiiDetector } from '@omadia/plugin-api';

import { C1_DEFAULT_THRESHOLD } from './c1Detector.js';
import { baselineHasIdentityPii, detectIdentityBaselineSync } from './promptMask.js';

/** Score from which C1 reports a span at all for field vetting — below the
 *  masking threshold, so a field whose names C1 is unsure about is not
 *  suggested as non-personal. */
export const C1_NEAR_MISS_THRESHOLD = 0.3;

/** Joined sample text per C1 call — under the sidecar's 20 KB text cap. */
const MAX_C1_TEXT_CHARS = 16_000;

/** Hit type recorded when the deny-list detector itself failed: the sample
 *  could not be cleared, so it counts as an identity hit (fail closed). */
const DENY_LIST_ERROR_TYPE = 'custom-error';

export const DEFAULT_PREVIEW_LIMIT = 5;
const MAX_PREVIEW_LIMIT = 50;

export interface VetSampleInput {
  readonly toolName: string;
  readonly fieldPath: string;
  readonly values: readonly string[];
  /** The operator's deny-list detector, when any is configured. */
  readonly customDetector?: PromptPiiDetector;
  /** The C1 detector, only when C1 is configured. */
  readonly c1Detector?: PromptPiiDetector;
  /** Spans at or above this score are a C1 `hit`. */
  readonly c1HitThreshold?: number;
}

async function identityTypes(
  values: readonly string[],
  customDetector: PromptPiiDetector | undefined,
): Promise<Set<string>> {
  const types = new Set<string>();
  for (const value of values) {
    if (baselineHasIdentityPii(value)) {
      for (const span of detectIdentityBaselineSync(value)) types.add(span.type);
    }
    if (customDetector === undefined) continue;
    try {
      for (const span of await customDetector.detect(value)) types.add(span.type);
    } catch {
      types.add(DENY_LIST_ERROR_TYPE);
    }
  }
  return types;
}

/** Newline-joined chunks of the sample, each under the sidecar's text cap. */
function c1Chunks(values: readonly string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const value of values) {
    const next = current.length === 0 ? value : `${current}\n${value}`;
    if (next.length > MAX_C1_TEXT_CHARS && current.length > 0) {
      chunks.push(current);
      current = value;
    } else {
      current = next;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function c1Verdict(
  values: readonly string[],
  detector: PromptPiiDetector | undefined,
  hitThreshold: number,
): Promise<{ readonly verdict: FieldSampleC1Verdict; readonly types: readonly string[] }> {
  if (detector === undefined || values.length === 0) return { verdict: 'unavailable', types: [] };
  let hit = false;
  let nearMiss = false;
  const types = new Set<string>();
  try {
    for (const chunk of c1Chunks(values)) {
      for (const span of await detector.detect(chunk)) {
        if (span.confidence >= hitThreshold) {
          hit = true;
          types.add(span.type);
        } else {
          nearMiss = true;
        }
      }
    }
  } catch {
    return { verdict: 'unavailable', types: [] };
  }
  if (hit) return { verdict: 'hit', types: [...types] };
  return { verdict: nearMiss ? 'near-miss' : 'clean', types: [] };
}

/** Vet one field's sample. Never throws; never returns a value. */
export async function vetSample(input: VetSampleInput): Promise<FieldSampleVerdict> {
  const identity = await identityTypes(input.values, input.customDetector);
  const c1 = await c1Verdict(
    input.values,
    input.c1Detector,
    input.c1HitThreshold ?? C1_DEFAULT_THRESHOLD,
  );
  return {
    toolName: input.toolName,
    fieldPath: input.fieldPath,
    sampleCount: input.values.length,
    identityHit: identity.size > 0,
    c1: c1.verdict,
    hitTypes: [...new Set([...identity, ...c1.types])].sort(),
  };
}

/** Every letter, digit and combining mark becomes `•`; spaces and
 *  punctuation stay, so the admin sees the value's shape, not the value. */
export function shapeMask(value: string): string {
  return value.replace(/[\p{L}\p{N}\p{M}]/gu, '•');
}

/** The shape-masked preview of a sample, at most `limit` entries. */
export function maskedPreview(values: readonly string[], limit?: number): string[] {
  const requested = limit !== undefined && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_PREVIEW_LIMIT;
  const n = Math.min(Math.max(requested, 0), MAX_PREVIEW_LIMIT);
  return values.slice(0, n).map(shapeMask);
}
