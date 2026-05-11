/**
 * Cheap regex-only pre-filter that decides whether a given answer is worth
 * sending through the verifier pipeline. Runs in the orchestrator hot path
 * after every turn, so it must stay purely synchronous and allocation-light.
 *
 * Policy (see §1 + §13 of the plan, "Mittelweg" variant):
 *   - Trigger if the answer contains at least one strong signal: currency
 *     amount, Odoo-style reference, ISO / German calendar date, aggregate
 *     keyword combined with a number.
 *   - Do NOT trigger on incidental numbers in prose ("es gibt 3 Module").
 *   - Always return a short list of matched reasons so we can log WHY the
 *     router fired — makes shadow-mode calibration debuggable.
 */

export interface TriggerDecision {
  /** Whether the verifier pipeline should run for this answer. */
  shouldVerify: boolean;
  /** Human-readable reasons, one per matched signal. Empty when false. */
  reasons: string[];
}

/**
 * Strong signals — any single hit flips the decision to `true`.
 *
 * Patterns are intentionally conservative: we want false-positives, not
 * false-negatives, but we also don't want to verify every trivial number.
 */
const STRONG_SIGNALS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // Currency: 1.234,56 €  |  €1234  |  EUR 1.234,00  |  1234.56 EUR
  // NOTE: no \b after the currency token — word boundaries do not fire
  // between two non-word characters (e.g. "€" followed by "." or end of
  // string), so we use a negative lookahead to avoid gluing into "EURO"
  // while still matching "€." and "€" at line end.
  {
    name: 'currency',
    pattern: /(?:€|EUR)\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|EUR)(?!\w)/i,
  },
  // Odoo / accounting references: INV/2026/0042, SO12345, PO/2025/0001,
  // RECH-2026-001 — three or more alnum chars with at least one digit and a
  // separator.
  {
    name: 'accounting_ref',
    pattern: /\b(?:INV|SO|PO|RECH|MOVE|BILL|RG|CR)[-/_]?\d{2,}[-/_\d]*\b/i,
  },
  // ISO date 2026-04-19 or German 19.04.2026
  {
    name: 'date',
    pattern: /\b(?:\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})\b/,
  },
  // Percentage with decimals: 12,5 % / 12.5% / 100%
  {
    name: 'percent',
    pattern: /\b\d{1,3}(?:[.,]\d+)?\s?%/,
  },
  // Hour / day totals that matter for HR: "42,5 Stunden", "12 Urlaubstage",
  // "3,5 Tage", "10 h"
  {
    name: 'hr_duration',
    pattern:
      /\b\d+(?:[.,]\d+)?\s?(?:Stunden?|std\.?|h|Urlaubstag(?:e)?|Arbeitstag(?:e)?|Tag(?:e)?)\b/i,
  },
];

/**
 * Soft signals: on their own they don't trigger, but they *boost* when paired
 * with a plain number. Example: "Summe: 42" — "Summe" alone is nothing, "42"
 * alone is nothing, together they're an aggregate claim worth verifying.
 */
const AGGREGATE_KEYWORDS = [
  'summe',
  'gesamt',
  'total',
  'saldo',
  'offen',
  'fällig',
  'faellig',
  'ausstehend',
  'durchschnitt',
  'anzahl',
  'insgesamt',
] as const;

const AGGREGATE_KEYWORDS_RE = new RegExp(
  `\\b(?:${AGGREGATE_KEYWORDS.join('|')})\\b`,
  'i',
);

/** Any digit sequence with 3+ digits (rules out "3 Module" etc.). */
const LARGE_NUMBER_RE = /\b\d{3,}(?:[.,]\d+)?\b/;

/**
 * Decide whether an answer is verification-worthy. Pure function, no I/O,
 * safe to call on every turn.
 */
export function shouldTriggerVerifier(answer: string): TriggerDecision {
  const reasons: string[] = [];
  if (answer.trim().length === 0) {
    return { shouldVerify: false, reasons };
  }

  for (const signal of STRONG_SIGNALS) {
    if (signal.pattern.test(answer)) {
      reasons.push(signal.name);
    }
  }

  if (AGGREGATE_KEYWORDS_RE.test(answer) && LARGE_NUMBER_RE.test(answer)) {
    reasons.push('aggregate_keyword_with_number');
  }

  return { shouldVerify: reasons.length > 0, reasons };
}
