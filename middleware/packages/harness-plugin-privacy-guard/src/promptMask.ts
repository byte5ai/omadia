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
import {
  CustomPatternWorker,
  PatternBudgetExceeded,
  type PatternResult,
  type WorkerPattern,
} from './customPatternWorker.js';
import {
  insideAny,
  isReservedSurrogateShape,
  protectedRanges,
} from './promptSurrogates.js';

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
/** The C0 baseline as a synchronous scan — the same patterns `createBaselineDetector`
 *  runs, without the async detector envelope. */
export function detectBaselineSync(text: string): PromptPiiSpan[] {
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
}

/**
 * True when the C0 baseline finds any PII shape (e-mail, IBAN, phone, address,
 * amount, date, id number) in `value`. Built for the v4 shape classifier's
 * one-way `detector` booster: a column of bare phone numbers is all digits and
 * would otherwise clear as an `id` handle — and a small dataset's digest
 * inlines every value of a safe column. With real values now flowing from
 * uploaded tables into the turn store, that is exactly the column that must
 * not clear.
 */
export function baselineHasPii(value: string): boolean {
  return detectBaselineSync(value).length > 0;
}

/** The C0 types that identify a PERSON. `date` and `amount` are deliberately
 *  not here: an ISO-date or a money column is exactly what the verb engine
 *  must keep filterable/sortable — masking it would kill "Rechnungen der
 *  letzten 3 Monate" server-side for every plugin. */
const IDENTITY_PII_TYPES: ReadonlySet<string> = new Set([
  'email',
  'iban',
  'phone',
  'address',
  'idnum',
]);

/**
 * `baselineHasPii` narrowed to identity types — the booster the v4 shape
 * classifier actually wants. A digits-only phone column is caught; a date or
 * amount column keeps its `safe-cleartext` verdict and its predicates.
 */
export function baselineHasIdentityPii(value: string): boolean {
  // Fast path: a bare ISO date/datetime is never an identity, however many
  // digit runs the phone pattern finds in it ("01-10" starts with `\b0`).
  if (ISO_DATE_VALUE.test(value.trim())) return false;
  return detectIdentityBaselineSync(value).length > 0;
}

/**
 * The C0 baseline's IDENTITY spans only (e-mail, IBAN, phone, address, id
 * number) — `date` and `amount` dropped, and a phone/idnum hit that lies
 * entirely inside a date span dropped with them (it IS the date). What a text
 * that must keep its dates and amounts readable (a tool error saying "no slot
 * on 2026-10-01", "budget of € 1.200 exhausted") gets masked for.
 */
export function detectIdentityBaselineSync(text: string): PromptPiiSpan[] {
  const spans = detectBaselineSync(text);
  const dates = spans.filter((s) => s.type === 'date');
  return spans.filter(
    (s) =>
      IDENTITY_PII_TYPES.has(s.type) &&
      !dates.some((d) => d.start <= s.start && d.end >= s.end),
  );
}

/** Same shape the v4 classifier's S3 rule accepts as a `date`. */
const ISO_DATE_VALUE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function createBaselineDetector(): PromptPiiDetector {
  return {
    id: 'c0-regex',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      return detectBaselineSync(text);
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

/** Adversarial probe corpus for the timeout guard. A catastrophic pattern
 *  like `(a+)+$` or `(\d+)+$` explodes on a homogeneous run followed by a
 *  MISMATCH, and its cost doubles per added character.
 *
 *  Character coverage matters as much as shape (review H1): a letter-only
 *  corpus waves `(\d+)+$` straight through — so the corpus runs over letters
 *  AND digits, plus mixed-alphanumeric, unicode-letter, and
 *  punctuation-heavy long probes. Construction-time vetting still cannot be
 *  sound against every input-dependent blowup — that is what the static
 *  nested-quantifier check and the RUNTIME backstop in `detect()` are for. */
const PROBE_TEXTS = [
  `${'a'.repeat(26)}b`,
  `${'1'.repeat(26)}x`,
  `${'a1'.repeat(13)}!`,
  `${'a'.repeat(2_000)}`,
  `${'1'.repeat(2_000)}`,
  `${'ab'.repeat(1_000)}!`,
  `${'12'.repeat(1_000)}x`,
  `${'ä'.repeat(500)}!`,
  `${'x '.repeat(1_000)}y`,
  `${'1.'.repeat(1_000)}x`,
];

/** #1553 — every probe runs in ESCALATING prefixes (its last character kept
 *  as the terminator), and the budget is checked after each one. A long
 *  probe tried in one go could itself freeze the event loop for minutes
 *  (`a*a*a*b` on 2 000 × `a`); fine steps on short prefixes catch an
 *  exponential blowup and ×1.5 steps a polynomial one before the next step
 *  can cost more than a small multiple of the budget. */
const PROBE_PREFIX_LENGTHS = [
  8, 12, 16, 18, 20, 22, 24, 26, 28, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1_024, 1_536,
];

function probeSteps(probe: string): string[] {
  const chars = [...probe];
  const terminator = chars[chars.length - 1] ?? '';
  const prefixes = PROBE_PREFIX_LENGTHS.filter((n) => n < chars.length - 1).map(
    (n) => chars.slice(0, n).join('') + terminator,
  );
  return [...prefixes, probe];
}

/** Runtime backstop budget for ONE custom pattern over ONE text. The
 *  construction checks bound what we can foresee; this bounds what we
 *  cannot: a pattern whose blowup is keyed on input the probes don't
 *  contain. The patterns run in a worker thread (`customPatternWorker.ts`,
 *  #1553); the main thread aborts the match once the call's budget (this ×
 *  the number of operator patterns) is spent, so the event loop never waits
 *  for it. An overrun throws `CustomPatternRuntimeError` — the service's
 *  tier-2 catch turns that into a BLOCKED turn, never an unmasked
 *  pass-through. The pattern stays active (see `detect()`). */
const RUNTIME_PATTERN_BUDGET_MS = 100;

export interface CustomTermsConfig {
  /** Literal terms, matched case-insensitively on word boundaries. */
  readonly terms: readonly string[];
  /** Operator-supplied regex sources (no flags; compiled with 'giu'). */
  readonly patterns: readonly string[];
  /** Test seam: override the per-pattern runtime budget (ms). */
  readonly runtimeBudgetMs?: number;
}

/** Thrown when a custom pattern blew its RUNTIME budget mid-turn (or the
 *  worker that runs the patterns failed). The service's tier-2 catch converts
 *  this into a blocked turn (fail-closed). The pattern is NOT disabled: the
 *  next turn runs it again (in a fresh worker), so the operator has to fix or
 *  remove it — the log line says which one. */
export class CustomPatternRuntimeError extends Error {
  constructor(
    public readonly source: string,
    elapsedMs: number,
    detail = 'exceeded its runtime budget',
  ) {
    super(
      `custom pattern ${JSON.stringify(source)} ${detail} (${String(Math.round(elapsedMs))}ms); the turn is blocked`,
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

/** Length of the quantifier at `source[at]` and whether it is unbounded
 *  (`*`, `+`, `{n,}`); `undefined` when there is none. A `{` that is no
 *  quantifier (`\p{L}` aside, `{x}`) is a literal. */
function quantifierAt(source: string, at: number): { length: number; unbounded: boolean } | undefined {
  const c = source[at];
  let length: number;
  let unbounded: boolean;
  if (c === '*' || c === '+') {
    length = 1;
    unbounded = true;
  } else if (c === '?') {
    length = 1;
    unbounded = false;
  } else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
    if (m === null) return undefined;
    length = m[0].length;
    unbounded = m[2] !== undefined && m[3] === '';
  } else {
    return undefined;
  }
  // A lazy/possessive marker belongs to the quantifier.
  if (source[at + length] === '?') length++;
  return { length, unbounded };
}

/** Length of the group prefix after `(`: `?:`, `?=`, `?!`, `?<=`, `?<!`,
 *  `?<name>`; 0 for a plain capture group. */
function groupPrefixLength(source: string, at: number): number {
  if (source[at] !== '?') return 0;
  const m = /^\?(?:[:=!]|<[=!]|<[^>]*>)/.exec(source.slice(at));
  return m === null ? 1 : m[0].length;
}

/**
 * #1553 — the classic catastrophic shape, found statically: a group repeated
 * without bound (`(...)+`, `(...)*`, `(...){n,}`) whose body itself contains
 * an unbounded quantifier — `(x+x+)+y`, `(a+)+$`, `(\d+)*`, `((ab)*c)+`.
 * The probe corpus only catches such a pattern when it happens to hold the
 * character run it explodes on; this check needs no input. Escapes and
 * character classes are skipped as atoms (`[+*]+` is fine). Errs towards
 * flagging (`(\w+\s)+` is flagged although its separator keeps it linear),
 * which is why a hit is only a warning at save time, never a rejection.
 */
export function hasNestedUnboundedQuantifier(source: string): boolean {
  // One frame per open group: does its body hold an unbounded quantifier?
  const frames: boolean[] = [false];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    let atomHasUnbounded = false;
    if (c === '\\') {
      i += 2;
    } else if (c === '[') {
      i++;
      if (source[i] === '^') i++;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '(') {
      frames.push(false);
      i += 1 + groupPrefixLength(source, i + 1);
      continue;
    } else if (c === ')') {
      atomHasUnbounded = frames.length > 1 ? frames.pop()! : false;
      i++;
    } else {
      i++;
      const q = quantifierAt(source, i - 1);
      // A bare quantifier character (`*` with no atom) is a syntax matter.
      if (q !== undefined) {
        i += q.length - 1;
        continue;
      }
    }
    const q = quantifierAt(source, i);
    if (q !== undefined) {
      if (q.unbounded && atomHasUnbounded) return true;
      i += q.length;
    }
    if (atomHasUnbounded || q?.unbounded === true) frames[frames.length - 1] = true;
  }
  return false;
}

/** Compile + vet one operator regex: syntax first, then the static
 *  nested-quantifier check, then a wall-clock probe against the adversarial
 *  corpus. Rejected patterns are reported, never silently dropped — an
 *  operator who typed a protection deserves to know it is not active. */
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
  // A warning, not a rejection: the check also flags linear patterns like
  // `(\w+\s)+`, and a rejected pattern is an INACTIVE protection — fail-open
  // for exactly the values the operator meant to mask. What bounds a truly
  // catastrophic pattern is the worker's runtime budget (`customPatternWorker`):
  // the match is stopped, the turn blocked, the event loop never waits.
  if (hasNestedUnboundedQuantifier(source)) {
    console.warn(
      `[privacy-guard v4] customPatternNestedQuantifier pattern=${JSON.stringify(source)} — a repeated group with an unbounded quantifier inside can backtrack catastrophically; it stays active, and a turn whose text makes it exceed its runtime budget is blocked. Rewrite it without the outer repetition if you can`,
    );
  }
  const startedAt = Date.now();
  for (const probe of PROBE_TEXTS) {
    for (const step of probeSteps(probe)) {
      re.lastIndex = 0;
      re.test(step);
      if (Date.now() - startedAt > CUSTOM_PATTERN_PROBE_BUDGET_MS) {
        return { rejected: { source, reason: 'too_slow' } };
      }
    }
  }
  re.lastIndex = 0;
  return { re };
}

function customSpan(start: number, end: number): PromptPiiSpan {
  return { start, end, type: 'custom', confidence: 1 };
}

/**
 * #760 — operator-defined deny-list detector. Literal `terms` (project code
 * names, customer names, internal identifiers) are matched case-insensitively
 * on word boundaries; `patterns` are operator regexes vetted at construction
 * (syntax, nested quantifiers, a backtracking time budget) and run in a
 * worker thread under a runtime budget (#1553). Every span reports type
 * 'custom' with confidence 1 and flows through the same surrogate +
 * fail-closed machinery as the built-in C0 patterns — `findIdentityLeaks`
 * covers custom values automatically.
 */
export function createCustomTermsDetector(config: CustomTermsConfig): {
  detector: PromptPiiDetector | undefined;
  rejected: readonly RejectedCustomPattern[];
} {
  const rejected: RejectedCustomPattern[] = [];
  const runtimeBudgetMs = config.runtimeBudgetMs ?? RUNTIME_PATTERN_BUDGET_MS;

  const terms = config.terms.map((t) => t.trim()).filter((t) => t.length > 0);
  // Unicode-aware boundaries: plain \b misclassifies umlauts under 'u'.
  // Escaped-literal alternation is linear — it runs on the main thread,
  // exempt from the runtime budget (throwing here could only ever be load,
  // never pathology).
  const termsRe =
    terms.length === 0
      ? undefined
      : new RegExp(
          `(?<![\\p{L}\\p{N}_])(?:${[...terms]
            .sort((a, b) => b.length - a.length) // longest-first alternation
            .map(escapeRegExp)
            .join('|')})(?![\\p{L}\\p{N}_])`,
          'giu',
        );
  const patterns: WorkerPattern[] = [];
  for (const source of config.patterns.map((p) => p.trim()).filter((p) => p.length > 0)) {
    const vetted = vetPattern(source);
    if ('rejected' in vetted) rejected.push(vetted.rejected);
    else patterns.push({ source: vetted.re.source, flags: vetted.re.flags });
  }

  if (termsRe === undefined && patterns.length === 0) return { detector: undefined, rejected };
  const worker = patterns.length > 0 ? new CustomPatternWorker() : undefined;
  return {
    rejected,
    detector: {
      id: 'custom-terms',
      async detect(text: string): Promise<readonly PromptPiiSpan[]> {
        const spans: PromptPiiSpan[] = [];
        if (termsRe !== undefined) {
          for (const match of text.matchAll(new RegExp(termsRe.source, termsRe.flags))) {
            if (match[0].length > 0) spans.push(customSpan(match.index, match.index + match[0].length));
          }
        }
        if (worker === undefined) return spans;
        const results = await runOperatorPatterns(worker, patterns, text, runtimeBudgetMs);
        for (const [index, result] of results.entries()) {
          // Runtime backstop (review H1) per pattern, on the worker's own
          // clock. Over budget ⇒ throw — the service's tier-2 catch BLOCKS
          // the turn (fail-closed). No auto-disable: skipping the pattern on
          // later turns would be fail-OPEN for exactly the values it was
          // meant to protect. The operator sees the greppable log and
          // removes/fixes the pattern.
          if (result.elapsedMs > runtimeBudgetMs) {
            throw runtimeExceeded(patterns[index]!.source, result.elapsedMs);
          }
          for (const [start, end] of result.spans) spans.push(customSpan(start, end));
        }
        return spans;
      },
    },
  };
}

function runtimeExceeded(source: string, elapsedMs: number): CustomPatternRuntimeError {
  console.error(
    `[privacy-guard v4] customPatternRuntimeExceeded pattern=${JSON.stringify(source)} elapsedMs=${String(Math.round(elapsedMs))} — turn will be blocked; remove or fix this pattern`,
  );
  return new CustomPatternRuntimeError(source, elapsedMs);
}

/** The operator patterns over `text` in the worker, with the call's budget
 *  (per-pattern budget × pattern count) enforced from the main thread. Every
 *  failure is a `CustomPatternRuntimeError`, so the caller fails closed. */
async function runOperatorPatterns(
  worker: CustomPatternWorker,
  patterns: readonly WorkerPattern[],
  text: string,
  runtimeBudgetMs: number,
): Promise<readonly PatternResult[]> {
  try {
    return await worker.match(patterns, text, runtimeBudgetMs * patterns.length);
  } catch (err) {
    if (err instanceof PatternBudgetExceeded) {
      throw runtimeExceeded(err.culprit ?? '(custom patterns)', err.elapsedMs);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[privacy-guard v4] customPatternWorkerFailed error=${JSON.stringify(message)} — turn will be blocked`,
    );
    throw new CustomPatternRuntimeError('(custom patterns)', 0, 'could not run');
  }
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

/** Run every detector over `text`, in order, tagging each span with its
 *  detector id. A throwing detector propagates — callers decide whether that
 *  blocks (prompt masking) or withholds (tool-error redaction). */
export async function collectDetectorSpans(
  text: string,
  detectors: readonly PromptPiiDetector[],
): Promise<Array<{ span: PromptPiiSpan; detector: string }>> {
  const detected: Array<{ span: PromptPiiSpan; detector: string }> = [];
  for (const detector of detectors) {
    const spans = await detector.detect(text);
    for (const span of spans) detected.push({ span, detector: detector.id });
  }
  return detected;
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
  const detected = await collectDetectorSpans(text, detectors);
  // #1528 / #1529 — a surrogate is not a new real value. A span that is (or,
  // after word-boundary extension, swallowed) a reserved surrogate shape — a
  // replayed answer that kept `LUKAS.BECKER@EXAMPLE.NET`, a deny-list term
  // inside `PLATZHALTER-CUSTOM-1` — stays as written: masking it again would
  // give the model a second stand-in for the same person. Realistic
  // surrogates ("Lukas Becker") are not exempt: a real person may bear the
  // name.
  const spans = dedupSpans(text, detected).filter(
    (s) => !isReservedSurrogateShape(s.value),
  );
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
    if (masked.includes(real)) masked = replaceOutsideSurrogates(masked, real, surrogate, map);
  }
  return masked;
}

/**
 * Every occurrence of `real` in `text` that is not wholly inside a surrogate,
 * replaced by `surrogate` (#1529). Without the exception, the deny-list term
 * `CUSTOM` (or `TOM`) was swept out of its own placeholder
 * `PLATZHALTER-CUSTOM-1`, the placeholder came out mangled with the term
 * still in it, and the residual check blocked the whole message.
 */
function replaceOutsideSurrogates(
  text: string,
  real: string,
  surrogate: string,
  map: PseudonymMap,
): string {
  const ranges = protectedRanges(text, map);
  let out = '';
  let cursor = 0;
  for (let at = text.indexOf(real); at !== -1; at = text.indexOf(real, at + real.length)) {
    if (insideAny(at, at + real.length, ranges)) continue;
    out += text.slice(cursor, at) + surrogate;
    cursor = at + real.length;
  }
  return out + text.slice(cursor);
}
