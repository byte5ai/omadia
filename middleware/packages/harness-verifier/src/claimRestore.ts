import type { Claim, VerifierPrivacy } from './claimTypes.js';

/**
 * Maps claims extracted from a turn's WIRE view back to real values,
 * server-side, before anything checks them (see {@link VerifierPrivacy}).
 *
 * Behind a Privacy Shield the claim extractor reads the answer as the turn's
 * model wrote it, placeholders included. Everything the deterministic
 * re-query and the evidence lookup read must be real again:
 *
 *   - `text`, `relatedEntities`, `odooRecord.ref` and a string `value` that
 *     is itself a placeholder go through the turn's restore;
 *   - a claim is kept only when its restored text is verbatim in the REAL
 *     answer: a span that cut through a placeholder ("Musterfrau
 *     wechselte") restores to nothing the user was shown;
 *   - a `value` the model parsed from a placeholder is fake (the surrogate
 *     pools mint realistic amounts and dates). It is re-derived from the
 *     real literal the placeholder stands for, and dropped when that literal
 *     cannot be read unambiguously — the checker then reports `unverified`
 *     instead of comparing a placeholder against the source, and a claim
 *     whose check would read the sentence instead is not checked at all.
 */

/** The sentence of the real answer around a claim (`claimContext`). */
export type ClaimContextOf = (text: string, answer: string) => string | undefined;

export async function restoreClaims(
  claims: readonly Claim[],
  privacy: VerifierPrivacy,
  realAnswer: string,
  contextOf: ClaimContextOf,
): Promise<Claim[]> {
  const hay = realAnswer.toLowerCase();
  const out: Claim[] = [];
  for (const claim of claims) {
    const text = await privacy.restore(claim.text);
    if (!hay.includes(text.toLowerCase())) continue;
    const value = await restoreValue(claim, text, privacy);
    if (value === undefined && claim.value !== undefined && checksTextWithoutValue(claim)) {
      continue;
    }
    const context = contextOf(text, realAnswer);
    const relatedEntities = await Promise.all(
      claim.relatedEntities.map((entity) => privacy.restore(entity)),
    );
    const odooRecord = claim.odooRecord
      ? {
          ...claim.odooRecord,
          ...(claim.odooRecord.ref !== undefined
            ? { ref: await privacy.restore(claim.odooRecord.ref) }
            : {}),
        }
      : undefined;
    out.push({
      id: claim.id,
      text,
      type: claim.type,
      expectedSource: claim.expectedSource,
      relatedEntities,
      ...(value !== undefined ? { value } : {}),
      ...(claim.unit !== undefined ? { unit: claim.unit } : {}),
      ...(claim.aggregation !== undefined ? { aggregation: claim.aggregation } : {}),
      ...(odooRecord ? { odooRecord } : {}),
      ...(context ? { context } : {}),
    });
  }
  return out;
}

/**
 * Checks that read the claim's text when it carries no value: the date check
 * parses the first date in it, the graph id check searches for it. Once a
 * placeholder-derived value is dropped, that text is a restored sentence
 * that may hold another literal, so such a claim is not checked at all —
 * fewer checks, never a false contradiction.
 */
function checksTextWithoutValue(claim: Claim): boolean {
  if (claim.type === 'date') return true;
  return (
    claim.type === 'id' &&
    claim.expectedSource === 'graph' &&
    claim.odooRecord?.ref === undefined
  );
}

/**
 * The claim's `value` in real terms. `realText` is the restored span; when it
 * equals the wire span no placeholder was involved and the model's value
 * stands.
 */
async function restoreValue(
  claim: Claim,
  realText: string,
  privacy: VerifierPrivacy,
): Promise<number | string | undefined> {
  const value = claim.value;
  if (value === undefined || realText === claim.text) return value;
  if (typeof value === 'string') {
    const restored = await privacy.restore(value);
    // The value is itself a placeholder literal: read its real counterpart.
    if (restored !== value) return reparse(claim, restored);
  }
  switch (claim.type) {
    case 'amount':
    case 'aggregate':
      return rederive(value, claim.text, realText, amountLiterals, amountOf);
    case 'date':
      return rederive(value, claim.text, realText, dateLiterals, isoDateOf);
    default:
      // No literal grammar for ids and names: keep the value only when the
      // user was shown it verbatim, never a fragment of a placeholder.
      return realText.toLowerCase().includes(String(value).toLowerCase())
        ? value
        : undefined;
  }
}

/** A restored placeholder literal, in the shape the checker compares. */
function reparse(claim: Claim, literal: string): number | string | undefined {
  switch (claim.type) {
    case 'amount':
    case 'aggregate':
      return amountOf(literal);
    case 'date':
      return isoDateOf(literal);
    default:
      return literal;
  }
}

/**
 * Restore swaps whole literals, so the span's n-th literal of a kind is the
 * n-th in the real text. With exactly one on each side: unchanged ⇒ the
 * model parsed a real literal and its value stands; changed ⇒ it parsed a
 * placeholder and the value is re-read from the real literal. No literal on
 * the wire ⇒ the value did not come from a masked amount/date. Anything else
 * is ambiguous and dropped.
 */
function rederive(
  value: number | string,
  wireText: string,
  realText: string,
  literals: (text: string) => string[],
  read: (literal: string) => number | string | undefined,
): number | string | undefined {
  const onWire = literals(wireText);
  if (onWire.length === 0) return value;
  const real = literals(realText);
  if (onWire.length !== 1 || real.length !== 1) return undefined;
  const [wireLiteral] = onWire;
  const [realLiteral] = real;
  if (wireLiteral === undefined || realLiteral === undefined) return undefined;
  return wireLiteral === realLiteral ? value : read(realLiteral);
}

// --- literal grammar -----------------------------------------------------
// Currency-anchored amounts and numeric dates: the shapes the prompt mask
// replaces (surrogates are "€12345" and "dd.mm.yyyy").

const CURRENCY = String.raw`(?:[€$£]|\b(?:EUR|USD|GBP|CHF)\b)`;
/** Digits grouped by thousands (".", ",", space, NBSP, narrow NBSP) with an
 *  optional one- or two-digit decimal part, or a plain digit run. */
const NUMBER = String.raw`(?:\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?!\d)`;
const AMOUNT_LITERAL = new RegExp(
  String.raw`${CURRENCY}\s?(${NUMBER})|(?<![\d.,])(${NUMBER})\s?${CURRENCY}`,
  'g',
);
const GROUPED_NUMBER = /^(\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/;

/** The number part of every currency-anchored amount in `text`. */
function amountLiterals(text: string): string[] {
  return [...text.matchAll(AMOUNT_LITERAL)]
    .map((m) => m[1] ?? m[2])
    .filter((n): n is string => n !== undefined);
}

/** "72,000" → 72000, "1.234,56" → 1234.56, "12,5" → 12.5; `undefined`
 *  for anything that is not exactly one grouped amount. */
function amountOf(literal: string): number | undefined {
  const number = amountLiterals(literal)[0] ?? literal.trim();
  const m = GROUPED_NUMBER.exec(number);
  if (!m?.[1]) return undefined;
  const n = Number(`${m[1].replace(/\D/g, '')}.${m[2] ?? '0'}`);
  return Number.isFinite(n) ? n : undefined;
}

const DATE_LITERAL = /\b(?:\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}|(?:19|20)\d{2}-\d{2}-\d{2})\b/g;

function dateLiterals(text: string): string[] {
  return [...text.matchAll(DATE_LITERAL)].map((m) => m[0]);
}

/** ISO "yyyy-mm-dd" for an ISO or German day-first dotted date. Slash and
 *  dash day/month orders are locale-ambiguous and yield `undefined`. */
function isoDateOf(literal: string): string | undefined {
  const trimmed = literal.trim();
  const iso = /^((?:19|20)\d{2})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return validDate(iso[1], iso[2], iso[3]);
  const german = /^(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})$/.exec(trimmed);
  if (german) return validDate(german[3], german[2], german[1]);
  return undefined;
}

function validDate(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
): string | undefined {
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
