/**
 * Process-wide C1 span cache for text that repeats ACROSS turns — the
 * recalled session tail, whose stored turns are re-masked on every turn.
 *
 * The per-turn cache in `service.ts` (#979) cannot serve that: it is keyed
 * by the whole text (the tail as a whole changes every turn — one turn in,
 * the oldest out) and it is dropped by `finalizeTurn`. Here the caller
 * detects each stored turn (a "segment") on its own and the result is kept
 * by content hash, so the next turn only sends the turns it has not seen.
 *
 * PRIVACY: nothing here holds text. The key is the sha256 of
 * `detectorId \0 scope \0 segment`; the value is the segment's spans —
 * offsets, a type and a confidence, no value. A hit returns spans that only
 * mean anything to a caller already holding the identical segment text.
 * `scope` is the identity of the detector's live configuration (its sidecar
 * URL), so a reconfigured sidecar never serves the previous one's results.
 *
 * Bounded twice: by entry count and by the total number of cached spans, so
 * a few span-dense segments cannot grow it without limit. Least recently
 * used entries go first (a `Map` keeps insertion order; a hit re-inserts).
 */

import { createHash } from 'node:crypto';

import type { PromptPiiSpan } from '@omadia/plugin-api';

/** Default entry cap — a few hundred sessions' worth of 10-turn tails. */
export const C1_SEGMENT_CACHE_MAX_ENTRIES = 2_000;
/** Default cap on the total number of cached spans across all entries. */
export const C1_SEGMENT_CACHE_MAX_SPANS = 50_000;

export interface C1SegmentCache {
  get(key: string): readonly PromptPiiSpan[] | undefined;
  set(key: string, spans: readonly PromptPiiSpan[]): void;
  readonly size: number;
}

/** sha256 hex of the detector id, its config scope and the segment text. */
export function c1SegmentKey(detectorId: string, scope: string, segment: string): string {
  return createHash('sha256')
    .update(detectorId)
    .update('\u0000')
    .update(scope)
    .update('\u0000')
    .update(segment)
    .digest('hex');
}

export function createC1SegmentCache(opts?: {
  readonly maxEntries?: number;
  readonly maxSpans?: number;
}): C1SegmentCache {
  const maxEntries = Math.max(1, opts?.maxEntries ?? C1_SEGMENT_CACHE_MAX_ENTRIES);
  const maxSpans = Math.max(0, opts?.maxSpans ?? C1_SEGMENT_CACHE_MAX_SPANS);
  const entries = new Map<string, readonly PromptPiiSpan[]>();
  let spanCount = 0;

  const remove = (key: string): void => {
    const existing = entries.get(key);
    if (existing === undefined) return;
    spanCount -= existing.length;
    entries.delete(key);
  };

  return {
    get(key) {
      const spans = entries.get(key);
      if (spans === undefined) return undefined;
      // Refresh recency: re-insert at the end of the iteration order.
      entries.delete(key);
      entries.set(key, spans);
      return spans;
    },
    set(key, spans) {
      remove(key);
      // An entry that alone exceeds the span cap is not kept — it would
      // evict everything else and still not fit.
      if (spans.length > maxSpans) return;
      const copy = Object.freeze(spans.map((s) => Object.freeze({ ...s })));
      entries.set(key, copy);
      spanCount += copy.length;
      while (entries.size > maxEntries || spanCount > maxSpans) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        remove(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
