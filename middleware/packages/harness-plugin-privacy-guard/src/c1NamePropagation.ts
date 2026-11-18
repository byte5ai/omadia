/**
 * Person-name propagation for SEGMENTED C1 detection.
 *
 * Detecting the recalled tail per stored turn (see `c1SegmentCache.ts`)
 * takes the cross-turn context away from GLiNER. Measured against the live
 * sidecar (8 KB synthetic German tail, 60 turns): whole-text found 140
 * person/address spans, per-segment 130 — every miss a surname-only mention
 * ("Frau Weißenborn") that the whole-text pass caught from ANOTHER turn
 * carrying the full name ("Helga Weißenborn"). No reverse differences.
 *
 * This step closes that gap deterministically: the name tokens of every
 * `person` span are masked wherever else they occur in the full text as a
 * whole word. It only ever ADDS spans, and runs on every call (cached or
 * not), so a cached and an uncached pass produce identical results.
 */

import type { PromptPiiSpan } from '@omadia/plugin-api';

/** Shortest token propagated — shorter ones ("Li", "Bo") collide with
 *  ordinary words too easily. */
const MIN_TOKEN_LENGTH = 4;

/** Titles and honorifics that may sit inside a person span but are not a
 *  name; compared without a trailing dot. Kept small and local on purpose. */
const HONORIFICS: ReadonlySet<string> = new Set([
  'Frau',
  'Herr',
  'Herrn',
  'Dr',
  'Prof',
  'Mr',
  'Mrs',
  'Ms',
  'Mx',
]);

const TOKEN_SEPARATOR = /[\s,]+/u;
const EDGE_NON_WORD = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const STARTS_UPPER = /^\p{Lu}/u;
/** A word character for the boundary test — letters (with combining marks),
 *  digits and the underscore. */
const WORD_CHAR = '[\\p{L}\\p{M}\\p{N}_]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Name tokens of the `person` spans, each with the highest confidence of a
 *  span it came from. */
function personNameTokens(
  text: string,
  spans: readonly PromptPiiSpan[],
): Map<string, number> {
  const tokens = new Map<string, number>();
  for (const span of spans) {
    if (span.type !== 'person') continue;
    for (const raw of text.slice(span.start, span.end).split(TOKEN_SEPARATOR)) {
      const token = raw.replace(EDGE_NON_WORD, '');
      if (token.length < MIN_TOKEN_LENGTH) continue;
      if (!STARTS_UPPER.test(token)) continue;
      if (HONORIFICS.has(token.replace(/\.$/u, ''))) continue;
      tokens.set(token, Math.max(tokens.get(token) ?? 0, span.confidence));
    }
  }
  return tokens;
}

/**
 * `spans` plus a `person` span for every whole-word occurrence (Unicode-aware
 * boundaries: never inside a longer word) of a person-span name token that
 * no existing span already covers. Never removes or alters a span; the input
 * array is not mutated. Output sorted by start offset.
 */
export function propagatePersonNames(
  text: string,
  spans: readonly PromptPiiSpan[],
): readonly PromptPiiSpan[] {
  const tokens = personNameTokens(text, spans);
  if (tokens.size === 0) return spans;
  const isCovered = (start: number, end: number): boolean =>
    spans.some((s) => s.start <= start && end <= s.end);
  const added: PromptPiiSpan[] = [];
  for (const [token, confidence] of tokens) {
    const pattern = new RegExp(
      `(?<!${WORD_CHAR})${escapeRegExp(token)}(?!${WORD_CHAR})`,
      'gu',
    );
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + token.length;
      if (isCovered(start, end)) continue;
      if (added.some((s) => s.start === start && s.end === end)) continue;
      added.push({ start, end, type: 'person', confidence });
    }
  }
  if (added.length === 0) return spans;
  return [...spans, ...added].sort((a, b) => a.start - b.start);
}
