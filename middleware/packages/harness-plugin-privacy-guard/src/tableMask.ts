/**
 * #1867 — PII masking for a whole uploaded table in linear time.
 *
 * The dataset import used to call `maskPrompt` once per text cell with one
 * growing turn map (#1546). Every call copied that map, rebuilt sets over all
 * earlier real values and swept every known value over the cell, so the cost
 * per cell grew with the number of values seen so far: 5,000 rows took 94 s,
 * 50,000 rows did not finish, and the synchronous detector never let the
 * event loop breathe, so `/health` and every chat stalled meanwhile.
 *
 * A table does not need the turn map's restore invariants (parts-free person
 * names, value-free dates, own-name exemptions): the import keeps no map, a
 * surrogate is stored at rest or shown as a sample, never restored. What it
 * does need is kept:
 *
 *   - the same detectors and span resolution as prompt masking
 *     (`collectDetectorSpans` + `dedupSpans`, reserved surrogate shapes left
 *     alone);
 *   - one surrogate per distinct value per table, distinct values never share
 *     one, and no surrogate equals a real value of the table (#1546);
 *   - the known-value sweep: a value detected in one cell is masked wherever
 *     else it appears in the table, even where no detector flagged it.
 *
 * Two passes: detect every cell first (so every real value of the table is
 * known before the first surrogate is minted), then mint and substitute. The
 * sweep looks values up in an index keyed by length, so a cell costs
 * O(length × distinct value lengths), independent of how many values the
 * table holds. Both passes yield to the event loop every
 * {@link TABLE_MASK_YIELD_EVERY} cells.
 */

import type { PromptPiiDetector } from '@omadia/plugin-api';

import { collectDetectorSpans, dedupSpans } from './promptMask.js';
import { isReservedSurrogateShape } from './promptSurrogates.js';
import { surrogateCandidates } from './v4/pseudonym.js';

/** Cells processed between two yields to the event loop. */
export const TABLE_MASK_YIELD_EVERY = 500;

export interface TableMaskResult {
  /** The cells, masked, in input order. A cell without PII is returned as is. */
  readonly masked: readonly string[];
}

interface CellSpan {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function isAllUpper(value: string): boolean {
  return value === value.toUpperCase() && value !== value.toLowerCase();
}

/** Real values grouped by length, for a substring lookup per cell position. */
class KnownValueIndex {
  private readonly byLength = new Map<number, Set<string>>();
  private readonly lengths: number[];

  constructor(values: Iterable<string>) {
    for (const value of values) {
      if (value.length === 0) continue;
      let bucket = this.byLength.get(value.length);
      if (bucket === undefined) {
        bucket = new Set();
        this.byLength.set(value.length, bucket);
      }
      bucket.add(value);
    }
    // Longest first: a longer known value wins over a shorter one it contains.
    this.lengths = [...this.byLength.keys()].sort((a, b) => b - a);
  }

  /** Every occurrence of a known value in `text`, longest values first. */
  find(text: string): CellSpan[] {
    const hits: CellSpan[] = [];
    for (const length of this.lengths) {
      if (length > text.length) continue;
      const bucket = this.byLength.get(length);
      if (bucket === undefined) continue;
      for (let at = 0; at + length <= text.length; at += 1) {
        const candidate = text.slice(at, at + length);
        if (bucket.has(candidate)) hits.push({ start: at, end: at + length, value: candidate });
      }
    }
    return hits;
  }
}

/** Detected spans first, then sweep hits that overlap nothing kept so far. */
function mergeSpans(detected: readonly CellSpan[], swept: readonly CellSpan[]): CellSpan[] {
  const kept = [...detected];
  for (const hit of swept) {
    if (kept.some((k) => hit.start < k.end && k.start < hit.end)) continue;
    kept.push(hit);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Consecutive taken candidates after which a type's realistic pool counts as
 * used up. The prompt pools cycle (phone numbers after 10,000, dates after
 * 6,240) — enough for a turn, not for a 50,000-row table; a table masker that
 * kept drawing from a cycled pool would never terminate.
 */
const POOL_EXHAUSTED_AFTER_MISSES = 1_000;

/** Unbounded, never-cycling placeholders for a type whose pool is used up. */
function* overflowCandidates(type: string): Generator<string> {
  for (let i = 1; ; i += 1) yield `PLATZHALTER-${type.toUpperCase()}-${String(i)}`;
}

/** A type's surrogate stream: the realistic pool, then placeholders. */
class SurrogateStream {
  private current: Generator<string>;
  private overflowed = false;

  constructor(private readonly type: string) {
    this.current = surrogateCandidates(type);
  }

  /** The next candidate `isFree` accepts. */
  take(isFree: (candidate: string) => boolean, transform: (raw: string) => string): string {
    let misses = 0;
    for (;;) {
      const next = this.current.next();
      // Unreachable: every stream is unbounded — keep the invariant loud.
      if (next.done === true) throw new Error('[privacy-shield] table surrogate pool exhausted');
      const candidate = transform(next.value);
      if (isFree(candidate)) return candidate;
      misses += 1;
      if (!this.overflowed && misses >= POOL_EXHAUSTED_AFTER_MISSES) {
        this.current = overflowCandidates(this.type);
        this.overflowed = true;
        misses = 0;
      }
    }
  }
}

/**
 * One surrogate per real value, bijective, never equal to a real value or to
 * a surrogate-shaped value the table already holds (`avoid`).
 */
function mintSurrogates(
  valueTypes: ReadonlyMap<string, string>,
  avoid: ReadonlySet<string>,
): Map<string, string> {
  const blockedLower = new Set([...valueTypes.keys(), ...avoid].map((v) => v.toLowerCase()));
  const streams = new Map<string, SurrogateStream>();
  const forward = new Map<string, string>();
  const isFree = (candidate: string): boolean => {
    const lower = candidate.toLowerCase();
    if (blockedLower.has(lower)) return false;
    blockedLower.add(lower);
    return true;
  };
  for (const [value, type] of valueTypes) {
    let stream = streams.get(type);
    if (stream === undefined) {
      stream = new SurrogateStream(type);
      streams.set(type, stream);
    }
    const upper = isAllUpper(value);
    forward.set(value, stream.take(isFree, (raw) => (upper ? raw.toUpperCase() : raw)));
  }
  return forward;
}

function substitute(
  text: string,
  spans: readonly CellSpan[],
  forward: ReadonlyMap<string, string>,
): string {
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const surrogate = forward.get(span.value);
    if (surrogate === undefined) continue;
    out += text.slice(cursor, span.start) + surrogate;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * Mask every cell of a table with one surrogate per distinct value. Never
 * returns a real value the detectors or the sweep found; a throwing detector
 * propagates (the import fails instead of storing unscanned cells).
 */
export async function maskTableCells(
  cells: readonly string[],
  detectors: readonly PromptPiiDetector[],
): Promise<TableMaskResult> {
  const detectedPerCell: CellSpan[][] = [];
  // Insertion order = first occurrence, so surrogates are deterministic.
  const valueTypes = new Map<string, string>();
  // Surrogate-shaped values already in the table stay as written (a value of
  // that shape carries nothing of anyone's data), but no fresh surrogate may
  // equal one — the table would then show two different things as one.
  const surrogateShaped = new Set<string>();
  for (let i = 0; i < cells.length; i += 1) {
    if (i > 0 && i % TABLE_MASK_YIELD_EVERY === 0) await yieldToEventLoop();
    const text = cells[i] ?? '';
    if (text.length === 0) {
      detectedPerCell.push([]);
      continue;
    }
    const spans: CellSpan[] = [];
    for (const span of dedupSpans(text, await collectDetectorSpans(text, detectors))) {
      if (isReservedSurrogateShape(span.value)) {
        surrogateShaped.add(span.value);
        continue;
      }
      if (!valueTypes.has(span.value)) valueTypes.set(span.value, span.type);
      spans.push({ start: span.start, end: span.end, value: span.value });
    }
    detectedPerCell.push(spans);
  }

  if (valueTypes.size === 0) return { masked: cells };

  const forward = mintSurrogates(valueTypes, surrogateShaped);
  const index = new KnownValueIndex(forward.keys());
  const masked: string[] = [];
  for (let i = 0; i < cells.length; i += 1) {
    if (i > 0 && i % TABLE_MASK_YIELD_EVERY === 0) await yieldToEventLoop();
    const text = cells[i] ?? '';
    if (text.length === 0) {
      masked.push(text);
      continue;
    }
    const spans = mergeSpans(detectedPerCell[i] ?? [], index.find(text));
    masked.push(spans.length === 0 ? text : substitute(text, spans, forward));
  }
  return { masked };
}
