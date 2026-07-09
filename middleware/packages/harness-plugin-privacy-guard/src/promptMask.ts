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
    // "72,000.50 USD".
    type: 'amount',
    re: /(?:[€$£]|\b(?:EUR|USD|GBP|CHF)\b)\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?\s?(?:[€$£]|(?:EUR|USD|GBP|CHF)\b)/g,
  },
  {
    // DOB-style dates: 24.12.1987, 1987-12-24, 24/12/1987.
    type: 'date',
    re: /\b(?:\d{1,2}[./]\d{1,2}[./](?:19|20)\d{2}|(?:19|20)\d{2}-\d{2}-\d{2})\b/g,
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

/**
 * Merge detector outputs: extend to word boundaries, then resolve overlaps
 * by keeping the higher-confidence span (ties → the longer span). Output is
 * sorted by start offset and non-overlapping.
 */
export function dedupSpans(
  text: string,
  detected: ReadonlyArray<{ span: PromptPiiSpan; detector: string }>,
): ResolvedSpan[] {
  const extended = detected
    .filter(({ span }) => span.end > span.start && span.start >= 0 && span.end <= text.length)
    .map(({ span, detector }) => {
      const { start, end } = extendToWordBoundaries(text, span.start, span.end);
      return { start, end, type: span.type, detector, confidence: span.confidence };
    })
    .sort(
      (a, b) =>
        b.confidence - a.confidence || b.end - b.start - (a.end - a.start) || a.start - b.start,
    );

  const kept: typeof extended = [];
  for (const candidate of extended) {
    const overlapping = kept.some(
      (k) => candidate.start < k.end && k.start < candidate.end,
    );
    if (!overlapping) kept.push(candidate);
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
