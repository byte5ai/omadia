/**
 * #361 — free-text user-prompt PII masking (detection + substitution).
 *
 * Detection is the pluggable `PromptPiiDetector` seam from `@omadia/plugin-api`.
 * This module ships:
 *   - `createBaselineDetector()` — the deterministic C0 regex baseline
 *     (email, IBAN, phone, German postal+street address, currency/salary
 *     amounts, DOB-style dates). C0 gates on STRUCTURED identifiers only —
 *     names/free-form addresses need the C1 transformer.
 *   - `createC1StubDetector()` — the wiring point for the C1 transformer
 *     ensemble (Piiranha / GLiNER). Deliberately inert until the committed
 *     validation harness (`src/validation/`) passes its documented recall
 *     gates for a target locale.
 *   - span dedup + word-boundary extension and `maskPrompt()` — the
 *     substitution pass over the shipped pseudonym-projection mechanism
 *     (`v4/pseudonym.ts`), longest-span-first.
 *
 * Substitution decision (#361, recorded): pseudonym projection with a
 * server-held real↔surrogate map resolved over the final answer — NOT a
 * reintroduced on-wire token map (deleted for cause by #119/#126/#153).
 */

import type { PromptPiiDetector, PromptPiiSpan } from '@omadia/plugin-api';

import {
  createPromptPseudonymMap,
  type PromptSpanValue,
} from './v4/pseudonym.js';
import type { PseudonymMap } from './v4/types.js';

// ---------------------------------------------------------------------------
// C0 — deterministic regex baseline.
// ---------------------------------------------------------------------------

interface C0Pattern {
  readonly type: string;
  readonly re: RegExp;
}

// Written-out month names across the six shipped locales (de/en/es/fr/it/nl),
// deduplicated. Feeds the written-date branch below; matched case-insensitively
// so a sentence-initial capitalised month ("Le 17 Septembre 1984") is caught.
const MONTH_NAMES = [
  // January … December, unioned across locales.
  'januar', 'january', 'janvier', 'enero', 'gennaio', 'januari',
  'februar', 'february', 'février', 'febrero', 'febbraio', 'februari',
  'märz', 'march', 'mars', 'marzo', 'maart',
  'april', 'avril', 'abril', 'aprile',
  'mai', 'may', 'mayo', 'maggio', 'mei',
  'juni', 'june', 'juin', 'junio', 'giugno',
  'juli', 'july', 'juillet', 'julio', 'luglio',
  'august', 'août', 'agosto', 'augustus',
  'september', 'septembre', 'septiembre', 'settembre',
  'oktober', 'october', 'octobre', 'octubre', 'ottobre',
  'november', 'novembre', 'noviembre',
  'dezember', 'december', 'décembre', 'diciembre', 'dicembre',
]
  // Longest-first so a shorter month that prefixes a longer one (e.g. "mar"
  // is not present, but "juni"/"junio") never wins the alternation early.
  .sort((a, b) => b.length - a.length)
  .join('|');

// Order matters only for readability; overlaps are resolved by dedup below.
const C0_PATTERNS: readonly C0Pattern[] = [
  {
    type: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    // IBAN — two letters, two check digits, 11–30 alphanumerics, optionally
    // grouped in spaced blocks of 4 (the common human spelling).
    type: 'iban',
    re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g,
  },
  {
    // Phone — international (+49 30 …) or local (030 / 0171 …) forms with
    // ≥7 digits total, tolerant of space/dash/paren grouping.
    type: 'phone',
    re: /(?:\+\d{1,3}[\s-]?|\b0)\d{1,4}(?:[\s\-/]?\d{2,6}){1,4}\b/g,
  },
  {
    // Spanish local mobile/landline: nine digits grouped 3-3-3 with no
    // leading 0 or +country prefix ("612 334 455"). The prefix digit is
    // constrained to 6-9 (the Spanish national number range) to shrink — NOT
    // eliminate — the false-positive surface.
    //
    // HONEST CAVEAT: C0 is locale-blind, so this pattern is global. It DOES
    // fire on any 3-3-3-grouped nine-digit run starting 6-9 in other locales
    // — e.g. a de/en quantity or serial like "700 300 200" masks as a phone.
    // Kept deliberately: masking is fail-closed, so an over-masked quantity
    // (degraded prompt) is a lesser harm than a leaked phone number (PII on
    // the wire). The committed negatives carry no such string, so the ≥ 85%
    // precision gate stays green; the production over-masking surface is
    // recorded in validation/RESULTS.md. Additive — the general phone
    // pattern above is left untouched.
    type: 'phone',
    re: /\b[6-9]\d{2}\s\d{3}\s\d{3}\b/g,
  },
  {
    // German street + number (+ optional postal code + city):
    // "Bahnhofstr. 5", "Bahnhofstraße 5, 60311 Frankfurt".
    type: 'address',
    re: /\b[A-ZÄÖÜ][a-zäöüß.-]+(?:[Ss]tr\.|[Ss]traße|[Ww]eg|[Pp]latz|[Aa]llee|[Gg]asse|[Rr]ing)\s?\d{1,4}[a-z]?(?:\s*,\s*\d{5}\s+[A-ZÄÖÜ][A-Za-zäöüß-]+)?/g,
  },
  {
    // Bare postal code + city ("60311 Frankfurt") not already caught above.
    type: 'address',
    re: /\b\d{5}\s+[A-ZÄÖÜ][A-Za-zäöüß-]{2,}\b/g,
  },
  {
    // Currency / salary amounts: "€72,000", "72.000 €", "EUR 72000",
    // "72,000.50 USD". The thousands separator class carries space and the
    // two Unicode spaces (NBSP U+00A0, narrow NBSP U+202F) alongside "." /
    // "," so French space-grouped amounts ("2 400 €", "72 000 €") are
    // caught. The trailing-currency branch uses `*` (was `+`) so a bare
    // amount with no grouping and a trailing symbol ("899 €", "150 €") also
    // matches — the currency symbol is the anchor, so this does not fire on
    // bare numbers.
    type: 'amount',
    re: /(?:[€$£]|\b(?:EUR|USD|GBP|CHF)\b)\s?\d{1,3}(?:[ \u00a0\u202f.,]\d{3})*(?:[.,]\d{1,2})?|\b\d{1,3}(?:[ \u00a0\u202f.,]\d{3})*(?:[.,]\d{1,2})?\s?(?:[€$£]|(?:EUR|USD|GBP|CHF)\b)/g,
  },
  {
    // DOB-style dates: numeric "24.12.1987" / "24/12/1987" / "24-12-1987"
    // (dot, slash, or Dutch dash separator), ISO "1987-12-24", and
    // written-out "17 septembre 1984" (month names across the six shipped
    // locales — case-insensitive so a sentence-initial month is caught).
    type: 'date',
    re: new RegExp(
      String.raw`\b(?:\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}` +
        String.raw`|(?:19|20)\d{2}-\d{2}-\d{2}` +
        String.raw`|\d{1,2}\s+(?:${MONTH_NAMES})\s+(?:19|20)\d{2})\b`,
      'gi',
    ),
  },
];

/** The deterministic C0 regex baseline (#361). Confidence is always 1 —
 *  every match is a hard pattern hit. Never throws. */
export function createBaselineDetector(): PromptPiiDetector {
  return {
    id: 'c0-regex',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      const spans: PromptPiiSpan[] = [];
      for (const { type, re } of C0_PATTERNS) {
        // Fresh regex state per call (global flag carries lastIndex).
        const pattern = new RegExp(re.source, re.flags);
        for (const match of text.matchAll(pattern)) {
          if (match.index === undefined || match[0].length === 0) continue;
          spans.push({
            start: match.index,
            end: match.index + match[0].length,
            type,
            confidence: 1,
          });
        }
      }
      return spans;
    },
  };
}

/**
 * C1 seam — transformer-ensemble slot (Piiranha / GLiNER). Ships INERT: it
 * reports no spans, so C0 alone decides until an operator wires a real
 * transformer detector AND the validation harness gates pass for the
 * locale. Kept as a concrete detector (not just a type) so the service's
 * degrade-to-C0 failure path has a stable seam to exercise in tests.
 */
export function createC1StubDetector(): PromptPiiDetector {
  return {
    id: 'c1-stub',
    async detect(): Promise<readonly PromptPiiSpan[]> {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Span dedup + word-boundary extension.
// ---------------------------------------------------------------------------

export interface ResolvedSpan {
  readonly start: number;
  readonly end: number;
  readonly type: string;
  readonly detector: string;
  readonly value: string;
}

const WORD_CHAR = /[\p{L}\p{N}_@.-]/u;

/** Extend a span outward while it splits a word-like run — a half-masked
 *  identifier is a leak (the RFC's word-boundary-extension trick). */
function extendToWordBoundaries(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s > 0 && WORD_CHAR.test(text[s - 1]!) && WORD_CHAR.test(text[s]!)) s--;
  while (e < text.length && WORD_CHAR.test(text[e]!) && WORD_CHAR.test(text[e - 1]!)) e++;
  return { start: s, end: e };
}

interface ExtendedSpan {
  start: number;
  end: number;
  readonly type: string;
  readonly detector: string;
  readonly confidence: number;
}

/** The parts of `[candidate.start, candidate.end)` not covered by any of
 *  `covering` (all overlapping the candidate, non-overlapping each other). */
function uncoveredParts(
  candidate: ExtendedSpan,
  covering: readonly ExtendedSpan[],
): Array<{ start: number; end: number }> {
  const parts: Array<{ start: number; end: number }> = [];
  let cursor = candidate.start;
  for (const k of [...covering].sort((a, b) => a.start - b.start)) {
    if (k.start > cursor) parts.push({ start: cursor, end: Math.min(k.start, candidate.end) });
    cursor = Math.max(cursor, k.end);
    if (cursor >= candidate.end) break;
  }
  if (cursor < candidate.end) parts.push({ start: cursor, end: candidate.end });
  return parts;
}

/** True when the slice holds at least one word-like character — a remainder
 *  of pure whitespace/punctuation carries nothing identifying and masking it
 *  would substitute separators. */
function hasWordChar(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (WORD_CHAR.test(text[i]!)) return true;
  }
  return false;
}

/**
 * Merge detector outputs: extend to word boundaries, then resolve overlaps
 * by letting the higher-confidence span (ties → the longer span) own the
 * contested characters. A losing span is NOT discarded wholesale: the parts
 * of it no winning span covers are kept as masking spans of their own —
 * otherwise a long low-confidence C1 span (e.g. a free-form address at
 * score 0.8) that merely brushes a short confidence-1 C0 hit (the postal
 * code inside it) would silently drop the rest of the address onto the
 * wire (#361 review finding). Output is sorted by start offset and
 * non-overlapping.
 */
export function dedupSpans(
  text: string,
  detected: ReadonlyArray<{ span: PromptPiiSpan; detector: string }>,
): ResolvedSpan[] {
  const extended: ExtendedSpan[] = detected
    .filter(({ span }) => span.end > span.start && span.start >= 0 && span.end <= text.length)
    .map(({ span, detector }) => {
      const { start, end } = extendToWordBoundaries(text, span.start, span.end);
      return { start, end, type: span.type, detector, confidence: span.confidence };
    })
    .sort(
      (a, b) =>
        b.confidence - a.confidence || b.end - b.start - (a.end - a.start) || a.start - b.start,
    );

  const kept: ExtendedSpan[] = [];
  for (const candidate of extended) {
    const overlapping = kept.filter(
      (k) => candidate.start < k.end && k.start < candidate.end,
    );
    if (overlapping.length === 0) {
      kept.push(candidate);
      continue;
    }
    // The candidate loses the contested characters, never its own coverage:
    // keep every uncovered remainder (re-extended to word boundaries —
    // kept-span edges already sit on word boundaries, so extension cannot
    // re-enter a kept span; if it ever would, fall back to the exact
    // remainder, which is non-overlapping by construction).
    for (const part of uncoveredParts(candidate, overlapping)) {
      if (!hasWordChar(text, part.start, part.end)) continue;
      const grown = extendToWordBoundaries(text, part.start, part.end);
      const collides = kept.some((k) => grown.start < k.end && k.start < grown.end);
      const bounds = collides ? part : grown;
      kept.push({ ...candidate, start: bounds.start, end: bounds.end });
    }
  }
  return kept
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, type, detector }) => ({
      start,
      end,
      type,
      detector,
      value: text.slice(start, end),
    }));
}

// ---------------------------------------------------------------------------
// Substitution.
// ---------------------------------------------------------------------------

export interface MaskPromptResult {
  readonly maskedText: string;
  /** Server-held map (extended from `existingMap` when given). */
  readonly map: PseudonymMap;
  /** The resolved spans, WITH real values — server-side use only. */
  readonly spans: readonly ResolvedSpan[];
}

/**
 * Run the detectors over `text` and substitute every resolved span with its
 * stable pseudonym. Replacement runs right-to-left over the original
 * offsets (equivalent to longest-span-first: spans are non-overlapping
 * after dedup, so offset order is the safe application order).
 *
 * `existingMap` threads the turn's server-held map through repeated calls
 * (user message, then the ingested attachment tail) so the same real value
 * always gets the same surrogate within a turn.
 */
export async function maskPrompt(
  text: string,
  detectors: readonly PromptPiiDetector[],
  existingMap?: PseudonymMap,
): Promise<MaskPromptResult> {
  const detected: Array<{ span: PromptPiiSpan; detector: string }> = [];
  for (const detector of detectors) {
    const spans = await detector.detect(text);
    for (const span of spans) detected.push({ span, detector: detector.id });
  }
  const spans = dedupSpans(text, detected);
  if (spans.length === 0) {
    return {
      maskedText: text,
      map: existingMap ?? { forward: new Map(), reverse: new Map() },
      spans,
    };
  }

  const spanValues: PromptSpanValue[] = spans.map((s) => ({
    value: s.value,
    type: s.type,
  }));
  const map = createPromptPseudonymMap(spanValues, text, existingMap);

  let masked = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    const surrogate = map.forward.get(span.value);
    // Defensive: the map covers every span value by construction.
    if (surrogate === undefined) continue;
    masked = masked.slice(0, span.start) + surrogate + masked.slice(span.end);
  }
  // Belt and braces: a detected value may occur AGAIN at a position no
  // detector flagged (e.g. an email repeated mid-sentence in a shape the
  // regex misses after boundary extension). Sweep every known real value —
  // including ones from earlier calls this turn via `existingMap` — longest
  // first, so the service's post-mask `findIdentityLeaks` assertion is a
  // true invariant, not a coin flip.
  for (const [real, surrogate] of [...map.forward.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    if (masked.includes(real)) masked = masked.split(real).join(surrogate);
  }
  return { maskedText: masked, map, spans };
}
