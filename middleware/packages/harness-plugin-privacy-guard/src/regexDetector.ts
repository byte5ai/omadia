/**
 * Regex-based PII detector — Slice 1b MVP.
 *
 * Five built-in patterns covering the high-recall structured-PII set
 * (email, IBAN, phone, credit-card, API-key). This is intentionally
 * coarse: regex catches structured strings well, but misses contextual
 * PII like names or contract clauses — those land with the Presidio
 * adapter in Slice 3 and the local-LLM detector for free-text in
 * Slice 3 as well.
 *
 * Output is INTERNAL: hits carry `value` and `span` so the policy
 * engine can replace them. The downstream `ReceiptAssembler` strips
 * those fields before anything user-facing is built — the public
 * `PrivacyReceipt` is PII-free by construction.
 *
 * Slice 3.1 adapter: `createRegexDetector()` wraps the legacy
 * `detectInText` synchronous scan into the `PrivacyDetector` shape that
 * the multi-detector service expects. The synchronous export stays for
 * existing tests + downstream packages.
 */

import type {
  PrivacyDetector,
  PrivacyDetectorOutcome,
} from '@omadia/plugin-api';

export const REGEX_DETECTOR_VERSION = '0.1.0';
export const REGEX_DETECTOR_ID = `regex:${REGEX_DETECTOR_VERSION}`;

export type DetectionType =
  | 'pii.email'
  | 'pii.iban'
  | 'pii.phone'
  | 'pii.credit_card'
  | 'pii.api_key';

export interface DetectorHit {
  readonly type: DetectionType;
  readonly value: string;
  /** [start, end) in the source string (UTF-16 code units, the JS-native unit). */
  readonly span: readonly [number, number];
  /** Confidence in [0, 1]. Regex hits are high-confidence by construction (>=0.9) —
   *  weaker signals would belong to an NER detector, not this one. */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Pattern table.
//
// Order matters: more-specific patterns (credit-card, IBAN) run before
// less-specific ones (phone) so a 16-digit credit card is not also
// re-classified as a long phone number. Each pattern's confidence is
// pinned so the receipt's `confidenceMin` aggregation makes sense even
// before NER lands.
// ---------------------------------------------------------------------------

interface PatternSpec {
  readonly type: DetectionType;
  readonly regex: RegExp;
  readonly confidence: number;
  /** Optional secondary validator — Luhn for credit-cards, IBAN-checksum
   *  for IBANs. Returns true to keep the hit, false to drop it. */
  readonly validate?: (raw: string) => boolean;
}

const PATTERNS: readonly PatternSpec[] = [
  // Credit card first — its 13-19 digit shape would also match a phone
  // pattern. Luhn check filters obvious false positives.
  {
    type: 'pii.credit_card',
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    confidence: 0.92,
    validate: (raw: string) => luhnCheck(raw.replace(/[ -]/g, '')),
  },
  // IBAN before phone for the same reason — country-code + checksum
  // structure is unambiguous.
  {
    type: 'pii.iban',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
    confidence: 0.99,
    validate: (raw: string) => ibanCheck(raw),
  },
  {
    type: 'pii.email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: 0.98,
  },
  // API key — heuristic. Catches `sk-…`, `pk-…`, generic
  // 32+ alphanumerics at word boundaries. Not perfect; Slice 2 lets
  // tenants extend.
  {
    type: 'pii.api_key',
    regex: /\b(?:sk|pk|api|key)[-_][A-Za-z0-9]{16,}\b/g,
    confidence: 0.9,
  },
  // Phone last so it does not eat credit-card / IBAN matches.
  // Strict: international format only (+CC ...). The original `\+?` form
  // hit dates, version strings, UUIDs and other digit-heavy noise — for
  // a Slice-2.1-grade regex detector we accept losing domestic-format
  // phone numbers in favour of zero false-positive on identifiers /
  // timestamps in long system prompts. Domestic-format detection lands
  // with the NER-based detectors in Slice 3.
  {
    type: 'pii.phone',
    regex: /\+\d{1,3}[\s.()-]{0,3}\d{2,5}[\s.()-]{0,3}\d{2,5}[\s.()-]{0,3}\d{2,8}/g,
    confidence: 0.92,
  },
];

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

/**
 * Scan a single string and return all PII hits. Hits are sorted by
 * ascending span-start so consumers can replace right-to-left without
 * re-indexing. Overlapping hits (across patterns) are resolved by
 * keeping the first-matched (higher-priority) pattern.
 */
export function detectInText(input: string): readonly DetectorHit[] {
  if (input.length === 0) return [];

  const hits: DetectorHit[] = [];
  const taken: Array<readonly [number, number]> = [];

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (let m = pattern.regex.exec(input); m !== null; m = pattern.regex.exec(input)) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlapsAny([start, end], taken)) continue;
      if (pattern.validate && !pattern.validate(m[0])) continue;
      hits.push({
        type: pattern.type,
        value: m[0],
        span: [start, end],
        confidence: pattern.confidence,
      });
      taken.push([start, end]);
    }
  }

  hits.sort((a, b) => a.span[0] - b.span[0]);
  return hits;
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function overlapsAny(
  candidate: readonly [number, number],
  taken: ReadonlyArray<readonly [number, number]>,
): boolean {
  const [cs, ce] = candidate;
  for (const [ts, te] of taken) {
    if (cs < te && ce > ts) return true;
  }
  return false;
}

/**
 * Slice 3.1 adapter — wrap the synchronous regex scan into the
 * `PrivacyDetector` contract. Always emits the hit's `detector` field as
 * `REGEX_DETECTOR_ID` so receipt-aggregation groups regex hits regardless
 * of which `(type, action)` bucket they fall into.
 *
 * Slice 3.2.1 update: returns `PrivacyDetectorOutcome` instead of bare
 * hits[]. Regex is synchronous + deterministic — every call has
 * `status: 'ok'`. The detector can never `skip`, `timeout`, or `error`.
 */
export function createRegexDetector(): PrivacyDetector {
  return {
    id: REGEX_DETECTOR_ID,
    async detect(text: string): Promise<PrivacyDetectorOutcome> {
      const hits = detectInText(text).map((h) => ({
        type: h.type,
        value: h.value,
        span: h.span,
        confidence: h.confidence,
        detector: REGEX_DETECTOR_ID,
      }));
      return { hits, status: 'ok' };
    },
  };
}

function luhnCheck(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const ch = digits[i];
    if (ch === undefined) return false;
    let d = ch.charCodeAt(0) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Minimal IBAN check: rearrange (move country+checksum to the end),
 * map letters to digits (A=10..Z=35), then mod-97 must equal 1. We do
 * not enforce per-country length tables — the regex already filters
 * obvious non-IBANs and the mod-97 catches the rest.
 */
function ibanCheck(raw: string): boolean {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (compact.length < 15 || compact.length > 34) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let buf = '';
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      buf += ch;
    } else if (code >= 65 && code <= 90) {
      buf += String(code - 55);
    } else {
      return false;
    }
  }
  // Big-int mod-97 via chunked accumulation so we do not need BigInt
  // for typical IBAN lengths.
  let remainder = 0;
  for (let i = 0; i < buf.length; i += 7) {
    const chunk = `${remainder}${buf.slice(i, i + 7)}`;
    const parsed = Number.parseInt(chunk, 10);
    if (!Number.isFinite(parsed)) return false;
    remainder = parsed % 97;
  }
  return remainder === 1;
}
