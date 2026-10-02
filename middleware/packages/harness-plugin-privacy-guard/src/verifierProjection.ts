/**
 * Projection of answer-verifier text through a turn's surrogate map.
 *
 * The answer verifier (claim extraction, evidence judging) sends model
 * requests AFTER the turn produced its answer. Its judge requests carry
 * knowledge-graph evidence the turn's own model only ever saw as an interned
 * digest, so that text is projected whether or not the operator enabled
 * `mask_user_prompt`:
 *
 *   - identity-bearing C0 shapes (e-mail, IBAN, phone, address, id number),
 *     the operator deny-list and the C1 detector, when wired;
 *   - every value the caller names as identity-bearing (an evidence node's
 *     id, display name and free-text fields), found case-insensitively;
 *   - the turn's known real values (the sweep in `maskPrompt`).
 *
 * Dates and amounts are deliberately NOT masked here: the v4 shape
 * classifier keeps them as `safe-cleartext` in digests too, and a realistic
 * surrogate date in the evidence next to a real one in the claim is exactly
 * the mismatch that would turn a correct answer into a "contradiction".
 *
 * Everything here is pure; the per-turn state lives in the service.
 */

import type { PromptPiiDetector, PromptPiiSpan } from '@omadia/plugin-api';

import { detectBaselineSync } from './promptMask.js';
import type { PseudonymMap } from './v4/types.js';
import {
  asValueLiteral,
  findValueLiterals,
  type ValueKind,
  type ValueLiteral,
} from './valueLiterals.js';

/** C0 types that identify a person. Mirrors `IDENTITY_PII_TYPES` in
 *  promptMask.ts: dates and amounts stay out on purpose. */
const IDENTITY_TYPES: ReadonlySet<string> = new Set([
  'email',
  'iban',
  'phone',
  'address',
  'idnum',
]);

/** Shorter values would match inside ordinary words far too often. */
const MIN_IDENTITY_VALUE_LENGTH = 2;

/** Detector id recorded (PII-free) in the receipt for caller-named values. */
export const IDENTITY_VALUES_DETECTOR_ID = 'identity-values';

/** Span type for caller-named values. Not a C0 type, so its surrogates come
 *  from the neutral `PLATZHALTER-NAME-n` pool: unambiguous for the judge and
 *  unable to collide with a real name. */
const IDENTITY_VALUE_TYPE = 'name';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The C0 baseline narrowed to identity types. A phone/id-number hit that lies
 * entirely inside a date span IS the date and is dropped with it (same rule
 * as `baselineHasIdentityPii`).
 */
export function createBaselineIdentityDetector(): PromptPiiDetector {
  return {
    id: 'c0-regex',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      const spans = detectBaselineSync(text);
      const dates = spans.filter((s) => s.type === 'date');
      return spans.filter(
        (s) =>
          IDENTITY_TYPES.has(s.type) &&
          !dates.some((d) => d.start <= s.start && d.end >= s.end),
      );
    },
  };
}

/**
 * Detector for values the caller KNOWS are identity-bearing. Matched
 * case-insensitively and as a substring — `dedupSpans` then widens each hit
 * to word boundaries, so a value is never half-replaced.
 */
export function createIdentityValuesDetector(
  values: readonly string[],
): PromptPiiDetector | undefined {
  const needles = [
    ...new Set(
      values
        .map((v) => v.trim())
        .filter((v) => v.length >= MIN_IDENTITY_VALUE_LENGTH),
    ),
  ].sort((a, b) => b.length - a.length);
  if (needles.length === 0) return undefined;
  const pattern = new RegExp(needles.map(escapeRegExp).join('|'), 'giu');
  return {
    id: IDENTITY_VALUES_DETECTOR_ID,
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      const spans: PromptPiiSpan[] = [];
      for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
        if (match.index === undefined || match[0].length === 0) continue;
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          type: IDENTITY_VALUE_TYPE,
          confidence: 1,
        });
      }
      return spans;
    },
  };
}

/**
 * True when a surrogate minted earlier this turn occurs in `text`. The
 * projection input is REAL text, so a hit is a real value that happens to
 * equal a surrogate (the surrogate pools are realistic German names). Masking
 * it would give two different people the same placeholder, and restoring the
 * judge's rationale would swap them — the caller must not send the text.
 */
export function hasSurrogateCollision(
  text: string,
  map: PseudonymMap | undefined,
): boolean {
  if (map === undefined) return false;
  for (const surrogate of map.reverse.keys()) {
    if (text.includes(surrogate)) return true;
  }
  return false;
}

/** Digits with any single separator between them removed ("10.000,00" →
 *  "1000000", also thin/no-break spaces and apostrophes). */
function joinDigitGroups(text: string): string {
  return text.replace(/(\d)[^\p{L}\p{N}](?=\d)/gu, '$1');
}

/** Numeric surrogates shorter than this are too likely to match a real number. */
const MIN_NUMERIC_SURROGATE_DIGITS = 5;

/**
 * How many surrogates of `map` still occur in `text`. A restored answer
 * should carry none; a hit means the model wrote a placeholder back in a
 * form restore cannot map back: in a different case, with re-grouped digits
 * ("€10000" as "10.000 €"), or — for a date or an amount placeholder — as
 * any literal of the same VALUE ("01.01.1970" as "1970-01-01" or
 * "1. Januar 1970", "€10000" as "10 Tsd. €"; see `valueLiterals.ts`). A
 * value that cannot be read counts as a match (fail closed): a literal with
 * no readable value matches every placeholder of its kind, and a placeholder
 * with none matches every literal of its kind. Heuristic by design — it errs
 * towards reporting a hit, and callers only use it to refuse an answer they
 * would otherwise have to flag anyway.
 */
export function countUnresolvedSurrogates(
  text: string,
  map: PseudonymMap | undefined,
): number {
  if (map === undefined || map.reverse.size === 0) return 0;
  const lower = text.toLowerCase();
  const digitText = joinDigitGroups(text);
  const literals = indexByKind(findValueLiterals(text));
  return [...map.reverse.keys()].filter(
    (surrogate) =>
      lower.includes(surrogate.toLowerCase()) ||
      carriesDigitsOf(digitText, surrogate) ||
      carriesValueOf(literals, surrogate),
  ).length;
}

function carriesDigitsOf(digitText: string, surrogate: string): boolean {
  const digits = surrogate.replace(/\D/g, '');
  return digits.length >= MIN_NUMERIC_SURROGATE_DIGITS && digitText.includes(digits);
}

/** The values a text's literals name, per kind; `unreadable` when one of
 *  that kind names none. */
interface KindValues {
  readonly values: ReadonlySet<string>;
  readonly unreadable: boolean;
}

function indexByKind(literals: readonly ValueLiteral[]): ReadonlyMap<ValueKind, KindValues> {
  const kinds = [...new Set(literals.map((literal) => literal.kind))];
  return new Map(
    kinds.map((kind): [ValueKind, KindValues] => {
      const ofKind = literals.filter((literal) => literal.kind === kind);
      return [
        kind,
        {
          values: new Set(ofKind.flatMap((literal) => literal.values)),
          unreadable: ofKind.some((literal) => literal.values.length === 0),
        },
      ];
    }),
  );
}

/** A date or amount placeholder whose value the text names in any spelling. */
function carriesValueOf(
  literals: ReadonlyMap<ValueKind, KindValues>,
  surrogate: string,
): boolean {
  const placeholder = asValueLiteral(surrogate);
  if (placeholder === undefined) return false;
  const seen = literals.get(placeholder.kind);
  if (seen === undefined) return false;
  if (seen.unreadable || placeholder.values.length === 0) return true;
  return placeholder.values.some((value) => seen.values.has(value));
}
