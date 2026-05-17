/**
 * Detector-hit span post-processing helpers.
 *
 * Some detectors — notably Presidio's spaCy `de_core_news_lg` NER —
 * systematically truncate German compound names by one character.
 * Examples observed on dev:
 *   "Christoph Schmidt" → detector reports "Christoph Schmid", leaving
 *      the final `t` next to the token.
 *   "Marcel Wege"       → detector reports "Marcel Weg",  leaving the
 *      final `e`.
 *
 * The leaked suffix is a privacy bug: the masked token (`«PERSON_N»`)
 * is supposed to hide the entire name, but a stray letter exposes the
 * name's length + last character. Extending the hit's span forward
 * through any adjacent Unicode word characters absorbs the trailing
 * remnant into the masked region.
 *
 * Symmetric backward extension is intentionally NOT done here — the
 * observed failure mode is always a tail-truncation. Backward
 * extension would risk swallowing legitimate preceding characters
 * (titles like "Dr.", or the previous word in a compound).
 */

export interface SpanLike {
  readonly span: readonly [number, number];
  readonly value: string;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Extend a single hit's span forward until the next non-word
 * character (or end-of-input). Returns the original object reference
 * when no extension is needed.
 */
export function extendHitSpanForward<T extends SpanLike>(text: string, hit: T): T {
  const [start, end] = hit.span;
  if (end >= text.length) return hit;
  if (!WORD_CHAR.test(text[end] ?? '')) return hit;
  let cursor = end;
  while (cursor < text.length && WORD_CHAR.test(text[cursor] ?? '')) {
    cursor += 1;
  }
  if (cursor === end) return hit;
  return {
    ...hit,
    span: [start, cursor] as const,
    value: text.slice(start, cursor),
  };
}

/**
 * Apply forward word-boundary extension to every hit in a batch.
 * Safe to call on empty arrays. Preserves order.
 */
export function extendHitsToWordBoundary<T extends SpanLike>(
  text: string,
  hits: readonly T[],
): readonly T[] {
  if (hits.length === 0 || text.length === 0) return hits;
  let changed = false;
  const out: T[] = [];
  for (const hit of hits) {
    const next = extendHitSpanForward(text, hit);
    if (next !== hit) changed = true;
    out.push(next);
  }
  return changed ? out : hits;
}
