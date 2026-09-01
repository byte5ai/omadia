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
    // #760 — national identity numbers with a DISTINCTIVE format. Previously
    // `idnum` was measured "informationally only and never gated"
    // (validation/README) with no pattern at all — a known false-negative
    // channel. Covered here (locale-blind, like everything in C0):
    //   DE Steuer-ID   11 digits, spoken "12 345 678 901" or bare
    //   DE USt-IdNr.   DE + 9 digits
    //   ES NIE / DNI   [XYZ]1234567L / 12345678Z
    //   IT Cod.Fiscale RSSMRA85T10A562S (6L 2D 1L 2D 1L 3D 1L)
    //   UK NINO        QQ 12 34 56 C
    //   FR n° sécu     1 85 05 78 006 084 (36) — 13 digits + optional key
    // Deliberately NOT covered: NL BSN — 9 bare digits with no distinguishing
    // shape; a global 9-digit pattern would mask half the numeric universe.
    // That gap stays recorded in validation/README.md.
    type: 'idnum',
    re: new RegExp(
      String.raw`\b(?:DE\s?\d{9}` + // USt-IdNr.
        String.raw`|\d{2}\s\d{3}\s\d{3}\s\d{3}` + // Steuer-ID (grouped)
        String.raw`|\d{11}` + // Steuer-ID (bare 11 digits)
        String.raw`|[XYZ]\s?-?\d{7}\s?-?[A-Z]` + // NIE
        String.raw`|\d{8}\s?-?[A-Z]` + // DNI
        String.raw`|[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]` + // Codice Fiscale
        // NINO — [A-Z]{2} on purpose (over-match beats a leak; the official
        // example prefix 'QQ' uses a letter the real allocation forbids).
        String.raw`|[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]` + // NINO
        String.raw`|[12]\s?\d{2}\s?(?:0[1-9]|1[0-2])\s?(?:\d{2}|2A|2B)\s?\d{3}\s?\d{3}(?:\s?\(?\d{2}\)?)?` + // FR sécu
        String.raw`)\b`,
    'g',
    ),
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

// ---------------------------------------------------------------------------
// #760 — operator-defined deny-list (custom terms + patterns).
// ---------------------------------------------------------------------------

/** Time budget for validating ONE custom regex against the probe corpus. JS
 *  RegExp is not RE2 — a pathological pattern can backtrack exponentially, and
 *  this detector runs on every turn. Validation happens once at detector
 *  construction (i.e. config-read time), never per turn. */
const CUSTOM_PATTERN_PROBE_BUDGET_MS = 50;

/** Adversarial probe corpus for the timeout guard. Ordered by ESCALATING
 *  pathological size: a catastrophic pattern like `(a+)+$` or `(\d+)+$`
 *  explodes on a homogeneous run followed by a MISMATCH, and its cost
 *  doubles per added character — so the small probes catch it within the
 *  budget before the larger ones could hang the thread for real. The budget
 *  check runs after EVERY probe; a linear pattern breezes through all.
 *
 *  Character coverage matters as much as shape (review H1): a letter-only
 *  corpus waves `(\d+)+$` straight through — so the escalation runs over
 *  letters AND digits, plus mixed-alphanumeric, unicode-letter, and
 *  punctuation-heavy long probes. Construction-time vetting still cannot be
 *  sound against every input-dependent blowup — that is what the RUNTIME
 *  backstop in `detect()` below is for. */
const PROBE_ESCALATION_SIZES = [18, 22, 26];
const PROBE_TEXTS = [
  ...PROBE_ESCALATION_SIZES.map((n) => `${'a'.repeat(n)}b`),
  ...PROBE_ESCALATION_SIZES.map((n) => `${'1'.repeat(n)}x`),
  ...PROBE_ESCALATION_SIZES.map((n) => `${'a1'.repeat(Math.ceil(n / 2))}!`),
  'a'.repeat(2_000),
  '1'.repeat(2_000),
  `${'ab'.repeat(1_000)}!`,
  `${'12'.repeat(1_000)}x`,
  `${'ä'.repeat(500)}!`,
  `${'x '.repeat(1_000)}y`,
  `${'1.'.repeat(1_000)}x`,
];

/** Runtime backstop budget for ONE custom pattern over ONE text. The
 *  construction probe bounds what we can foresee; this bounds what we
 *  cannot: a pattern whose blowup is keyed on input the probes don't
 *  contain. Exceeding it disables the pattern process-wide (loudly) and
 *  throws — the service's tier-2 catch turns that into a BLOCKED turn,
 *  never an unmasked pass-through. */
const RUNTIME_PATTERN_BUDGET_MS = 100;

export interface CustomTermsConfig {
  /** Literal terms, matched case-insensitively on word boundaries. */
  readonly terms: readonly string[];
  /** Operator-supplied regex sources (no flags; compiled with 'giu'). */
  readonly patterns: readonly string[];
  /** Test seam: override the per-pattern runtime budget (ms). */
  readonly runtimeBudgetMs?: number;
}

/** Thrown when a custom pattern blew its RUNTIME budget mid-turn. The
 *  service's tier-2 catch converts this into a blocked turn (fail-closed);
 *  the offending pattern is disabled process-wide so subsequent turns run
 *  without it (loudly logged at disable time). */
export class CustomPatternRuntimeError extends Error {
  constructor(public readonly source: string, elapsedMs: number) {
    super(
      `custom pattern ${JSON.stringify(source)} exceeded its runtime budget (${String(Math.round(elapsedMs))}ms) and was disabled`,
    );
    this.name = 'CustomPatternRuntimeError';
  }
}

export interface RejectedCustomPattern {
  readonly source: string;
  readonly reason: 'syntax' | 'too_slow';
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile + vet one operator regex: syntax first, then a wall-clock probe
 *  against the adversarial corpus. Rejected patterns are reported, never
 *  silently dropped — an operator who typed a protection deserves to know it
 *  is not active. */
function vetPattern(source: string): { re: RegExp } | { rejected: RejectedCustomPattern } {
  let re: RegExp;
  try {
    re = new RegExp(source, 'giu');
  } catch {
    try {
      // 'u' rejects some legacy-valid patterns; retry without it before failing.
      re = new RegExp(source, 'gi');
    } catch {
      return { rejected: { source, reason: 'syntax' } };
    }
  }
  const startedAt = Date.now();
  for (const probe of PROBE_TEXTS) {
    re.lastIndex = 0;
    re.test(probe);
    if (Date.now() - startedAt > CUSTOM_PATTERN_PROBE_BUDGET_MS) {
      return { rejected: { source, reason: 'too_slow' } };
    }
  }
  re.lastIndex = 0;
  return { re };
}

/**
 * #760 — operator-defined deny-list detector. Literal `terms` (project code
 * names, customer names, internal identifiers) are matched case-insensitively
 * on word boundaries; `patterns` are operator regexes vetted at construction
 * (syntax + a backtracking time budget). Every span reports type 'custom'
 * with confidence 1 and flows through the same surrogate + fail-closed
 * machinery as the built-in C0 patterns — `findIdentityLeaks` covers custom
 * values automatically.
 */
export function createCustomTermsDetector(config: CustomTermsConfig): {
  detector: PromptPiiDetector | undefined;
  rejected: readonly RejectedCustomPattern[];
} {
  const rejected: RejectedCustomPattern[] = [];
  const compiled: Array<{ re: RegExp; source: string; operatorPattern: boolean }> = [];
  const runtimeBudgetMs = config.runtimeBudgetMs ?? RUNTIME_PATTERN_BUDGET_MS;

  const terms = config.terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (terms.length > 0) {
    const alternation = terms
      .sort((a, b) => b.length - a.length) // longest-first alternation
      .map(escapeRegExp)
      .join('|');
    // Unicode-aware boundaries: plain \b misclassifies umlauts under 'u'.
    // Escaped-literal alternation is linear — exempt from the runtime budget
    // (throwing here could only ever be load, never pathology).
    compiled.push({
      re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, 'giu'),
      source: '(custom terms)',
      operatorPattern: false,
    });
  }
  for (const source of config.patterns.map((p) => p.trim()).filter((p) => p.length > 0)) {
    const vetted = vetPattern(source);
    if ('rejected' in vetted) rejected.push(vetted.rejected);
    else compiled.push({ re: vetted.re, source, operatorPattern: true });
  }

  if (compiled.length === 0) return { detector: undefined, rejected };
  return {
    rejected,
    detector: {
      id: 'custom-terms',
      async detect(text: string): Promise<readonly PromptPiiSpan[]> {
        const spans: PromptPiiSpan[] = [];
        for (const { re, source, operatorPattern } of compiled) {
          const startedAt = Date.now();
          const pattern = new RegExp(re.source, re.flags); // fresh lastIndex
          for (const match of text.matchAll(pattern)) {
            if (match.index === undefined || match[0].length === 0) continue;
            spans.push({
              start: match.index,
              end: match.index + match[0].length,
              type: 'custom',
              confidence: 1,
            });
          }
          // Runtime backstop (review H1): the construction probes cannot
          // foresee input-dependent blowup. Over budget ⇒ throw — the
          // service's tier-2 catch BLOCKS the turn (fail-closed). No
          // auto-disable: skipping the pattern on later turns would be
          // fail-OPEN for exactly the values it was meant to protect. The
          // operator sees the greppable log and removes/fixes the pattern.
          const elapsedMs = Date.now() - startedAt;
          if (operatorPattern && elapsedMs > runtimeBudgetMs) {
            console.error(
              `[privacy-guard v4] customPatternRuntimeExceeded pattern=${JSON.stringify(source)} elapsedMs=${String(Math.round(elapsedMs))} — turn will be blocked; remove or fix this pattern`,
            );
            throw new CustomPatternRuntimeError(source, elapsedMs);
          }
        }
        return spans;
      },
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
  /** Length of the detector's OWN match, BEFORE word-boundary extension. A
   *  span that matched its whole value natively is more self-contained than
   *  one that only reached the same range by growing across a shared
   *  separator — used as a tie-break key below (#727). */
  readonly nativeLen: number;
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
 * by letting the higher-confidence span own the contested characters. Ties
 * are broken by a documented, order-independent rule so the outcome never
 * depends on detector/pattern declaration order (#727): (1) higher
 * confidence, then (2) longer extended span, then (3) larger NATIVE match —
 * a span that matched its value directly beats one that only grew into the
 * same range (this is what makes the ISO date `2026-07-02` beat the phone
 * pattern that grabbed its `-07-02` tail and extended back over the `-`),
 * then — only for two spans still identical on all three — (4) a fixed
 * lexical order of the type name (present purely for determinism, NOT
 * semantic priority), then (5) earliest start.
 * A losing span is NOT discarded wholesale: the parts
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
      return {
        start,
        end,
        type: span.type,
        detector,
        confidence: span.confidence,
        nativeLen: span.end - span.start,
      };
    })
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.end - b.start - (a.end - a.start) ||
        // Native (pre-extension) match: the span that matched its whole value
        // beats one that only grew into the range across a shared separator.
        b.nativeLen - a.nativeLen ||
        // Deterministic last resort: a fixed lexical order of the type NAME.
        // The point is determinism — never array/pattern order (#727) — not
        // semantic priority: this only fires for two identical-range,
        // identical-native-length spans of different types, where no type is
        // "more right", so a fixed arbitrary order is the honest choice. Plain
        // code-unit compare, not localeCompare (which varies by locale).
        (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
        a.start - b.start,
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
    // NOTHING DETECTED IN *THIS* TEXT IS NOT NOTHING TO MASK.
    //
    // The turn's map already holds every real value masked by earlier calls,
    // and this text may well repeat one of them — a follow-up question naming
    // the same person, an attachment tail, a retry after the C1 detector
    // degraded. Returning the raw text here handed that value straight to the
    // wire, and the service's post-mask assertion (which checks the WHOLE
    // turn's map) then had to block the turn: correctly, because the value
    // really was about to leak, but the operator sees only "prompt masking
    // failed" on a message that looks harmless.
    //
    // So the known-value sweep runs even with zero fresh spans. It is the same
    // sweep as below and it can only ADD masking — it substitutes values this
    // turn already decided are PII, and never touches anything else.
    const carried = existingMap ?? { forward: new Map(), reverse: new Map() };
    return {
      maskedText: sweepKnownValues(text, carried),
      map: carried,
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
  return { maskedText: sweepKnownValues(masked, map), map, spans };
}

/**
 * Replace every real value the turn's map knows about, longest first.
 *
 * Belt and braces for the span pass: a detected value may occur AGAIN at a
 * position no detector flagged (an email repeated mid-sentence in a shape the
 * regex misses after boundary extension), and a value masked EARLIER in the
 * turn may reappear in a later text this pass's detectors say nothing about.
 * Both are the same operation, so both run through this one function — that is
 * what makes the service's post-mask `findIdentityLeaks` assertion a true
 * invariant rather than a coin flip.
 *
 * Longest first, because a shorter known value may be a substring of a longer
 * one's surrogate; doing the long ones first leaves the short sweep to clean up
 * whatever it re-introduced, never the other way round.
 */
function sweepKnownValues(text: string, map: PseudonymMap): string {
  let masked = text;
  for (const [real, surrogate] of [...map.forward.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    if (masked.includes(real)) masked = masked.split(real).join(surrogate);
  }
  return masked;
}
