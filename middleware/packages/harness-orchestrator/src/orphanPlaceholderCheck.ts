/**
 * Privacy-Engine Hardening Slice #4 — Orphan-Placeholder Detection.
 *
 * Phase A.2's post-egress scrub replaces unresolved privacy tokens with
 * conservative German placeholders (`[Name]`, `[Adresse]`, `[E-Mail]`,
 * …) when positional restoration is uncertain. These placeholders
 * preserve privacy and avoid misinformation, but they're opaque to
 * the user: they see `[Name]` in the chat and have no clue why or
 * what to do.
 *
 * This module adds the final user-facing layer: detect those orphans
 * in the channel-bound text after every privacy step has run, and
 * append a brief diagnostic footer explaining what happened. Pure,
 * stateless — no I/O, no retry logic. Retry-based mitigations are
 * deferred until receipt-persistence (S-7.5) lets us measure how
 * often this fires and whether a retry would actually help.
 */

/**
 * The placeholder strings Phase A.2 emits, keyed by their token-type
 * prefix. Kept in sync with `TYPE_PLACEHOLDERS` in
 * `@omadia/plugin-privacy-guard/selfAnonymization.ts`. Duplicating the
 * literal here avoids a cross-package import for a small constant —
 * the format is part of the protocol the orchestrator already speaks.
 *
 * Includes the generic `[Vertraulich]` fallback the scrub emits when
 * the token type doesn't match any of the known categories.
 */
const KNOWN_PLACEHOLDERS = [
  '[Name]',
  '[E-Mail]',
  '[Telefon]',
  '[IBAN]',
  '[Kreditkarte]',
  '[Adresse]',
  '[Organisation]',
  '[IP-Adresse]',
  '[Krypto-Adresse]',
  '[Schlüssel]',
  '[ID-Nummer]',
  '[Vertraulich]',
] as const;

export interface OrphanPlaceholderAnalysis {
  /** Total placeholder occurrences (counts duplicates). */
  readonly count: number;
  /** Distinct placeholder strings present, in first-seen order. */
  readonly types: readonly string[];
}

/**
 * Scan `text` for Phase A.2 placeholder strings. Pure regex scan —
 * counts ALL occurrences (a single answer with two `[Name]`s reports
 * count=2) and the distinct set of placeholder strings found. Empty
 * input + zero matches return `{ count: 0, types: [] }`.
 */
export function detectOrphanPlaceholders(
  text: string,
): OrphanPlaceholderAnalysis {
  if (text.length === 0) return { count: 0, types: [] };
  // Collect every occurrence with its position so we can sort by
  // text-order. Without this step, `types` would be in the order of
  // KNOWN_PLACEHOLDERS iteration, which is unrelated to where the
  // user actually sees the placeholders in the answer.
  const occurrences: Array<{ index: number; placeholder: string }> = [];
  for (const placeholder of KNOWN_PLACEHOLDERS) {
    let index = text.indexOf(placeholder);
    while (index !== -1) {
      occurrences.push({ index, placeholder });
      index = text.indexOf(placeholder, index + placeholder.length);
    }
  }
  occurrences.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const types: string[] = [];
  for (const occ of occurrences) {
    if (!seen.has(occ.placeholder)) {
      seen.add(occ.placeholder);
      types.push(occ.placeholder);
    }
  }
  return { count: occurrences.length, types };
}

/**
 * Append a brief explanatory footer when orphan placeholders are
 * present. Pure: returns the original text unchanged if no
 * placeholders were found OR if the footer would be a no-op
 * (extremely short input). Idempotent: re-applying to an already-
 * footered text does NOT add a second footer (the marker string is
 * checked).
 *
 * The footer is a single short paragraph in German — matches the
 * existing chat-UI tone, mentions the specific placeholder count so
 * the user can correlate, and points at the cause (privacy filter
 * could not resolve specific tokens). Operators can switch the text
 * via the optional `footerText` argument when we eventually wire a
 * configuration knob (out of scope for this slice).
 */
export const ORPHAN_PLACEHOLDER_FOOTER_MARKER =
  '<!-- privacy-engine: orphan-placeholders -->';

export function appendOrphanPlaceholderFooter(
  text: string,
  analysis: OrphanPlaceholderAnalysis = detectOrphanPlaceholders(text),
): string {
  if (analysis.count === 0) return text;
  if (text.includes(ORPHAN_PLACEHOLDER_FOOTER_MARKER)) return text;
  const types =
    analysis.types.length === 1
      ? analysis.types[0]!
      : analysis.types.join(', ');
  const footer = [
    '',
    '',
    '---',
    `_Hinweis: ${String(analysis.count)} Datenfeld${analysis.count === 1 ? '' : 'er'} (${types}) ` +
      'konnte vom Privacy-Filter nicht eindeutig zugeordnet werden und wurde durch einen Platzhalter ersetzt. ' +
      'Falls du den vollständigen Wert brauchst, frag bitte gezielter nach (mit eindeutigem Namen oder Kontext)._',
    ORPHAN_PLACEHOLDER_FOOTER_MARKER,
  ].join('\n');
  return text + footer;
}
