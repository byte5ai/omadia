/**
 * Tool-error redaction — the text behind a returned `Error:` string, on its way
 * to the model.
 *
 * A returned `Error:` string is control flow, not data: the model must read the
 * hint it carries (`requires \`scope\``, `use search_turns instead`), so the
 * dispatch seams never intern it as a dataset. But the text is not always
 * sanitized — an MCP server's error body or a plugin's exception wrapper can
 * quote the record it failed on. This module is the free-text pass the seams run
 * it through instead.
 *
 * Three deliberate differences from prompt masking (`promptMask.ts`):
 *  - IRREVERSIBLE. A span becomes `[masked:<type>]`, not a pseudonym, and the
 *    turn's surrogate map is never extended. A realistic pseudonym would read to
 *    the model as a real value it can act on, and adding the error's values to
 *    the map would re-hydrate them into the final answer.
 *  - IDENTITY TYPES ONLY from the regex baseline. `date` and `amount` stay: a
 *    tool error saying "no slot on 2026-10-01" or "budget of € 1.200 exhausted"
 *    is exactly the hint the model needs, and neither identifies a person.
 *  - UUID-SHAPED TOKENS are object ids, not phone numbers. The phone pattern
 *    matches digit runs between a UUID's hyphens (`…-0123-4567-…`); a hit that
 *    lies inside one is dropped, like a hit inside a date.
 *
 * The operator deny-list and the optional C1 detector run exactly as they do for
 * prompts (the service assembles the same detectors). Values the turn's prompt
 * masking already identified are swept too.
 */

import type {
  PromptMaskedSpanInfo,
  PromptPiiDetector,
  PromptPiiSpan,
} from '@omadia/plugin-api';

import {
  collectDetectorSpans,
  dedupSpans,
  detectIdentityBaselineSync,
} from './promptMask.js';

/** Receipt type for a value swept because the turn's prompt masking already
 *  identified it (the surrogate map records values, not their types). */
export const KNOWN_VALUE_SPAN_TYPE = 'known';
/** Detector id recorded for a swept known value. */
export const KNOWN_VALUE_DETECTOR = 'turn-map';

const UUID_TOKEN =
  /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;

/** Keep a detector-supplied type from breaking out of the marker. */
function markerFor(type: string): string {
  const safe = type.replace(/[^A-Za-z0-9_-]/g, '');
  return `[masked:${safe.length > 0 ? safe : 'pii'}]`;
}

/**
 * The C0 regex baseline as tool-error text needs it: identity types only, and
 * no hit that lies entirely inside a date or a UUID-shaped token.
 */
export function detectToolErrorBaselineSync(text: string): PromptPiiSpan[] {
  const spans = detectIdentityBaselineSync(text);
  if (spans.length === 0) return spans;
  const uuids: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(UUID_TOKEN)) {
    if (m.index !== undefined) uuids.push({ start: m.index, end: m.index + m[0].length });
  }
  if (uuids.length === 0) return spans;
  return spans.filter((s) => !uuids.some((u) => u.start <= s.start && u.end >= s.end));
}

/** {@link detectToolErrorBaselineSync} behind the detector seam. Same id as the
 *  prompt baseline — it IS the C0 baseline, narrowed. Never throws. */
export function createToolErrorBaselineDetector(): PromptPiiDetector {
  return {
    id: 'c0-regex',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      return detectToolErrorBaselineSync(text);
    },
  };
}

export interface ToolErrorRedaction {
  readonly text: string;
  /** PII-free span records (type + detector) for the receipt. */
  readonly spans: readonly PromptMaskedSpanInfo[];
  /** The REAL values that were replaced — server-side only, for the caller's
   *  residual check. Never leaves the service. */
  readonly values: readonly string[];
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly type: string;
}

function overlapsAny(
  start: number,
  end: number,
  taken: readonly Replacement[],
): boolean {
  return taken.some((r) => start < r.end && r.start < end);
}

/**
 * Detect and replace. Every position is decided on the ORIGINAL text and
 * substituted in one right-to-left pass, so a later sweep can never match
 * inside a marker an earlier step inserted.
 *
 *  1. detector spans, merged by the same `dedupSpans` prompt masking uses;
 *  2. further occurrences of every detected value that no detector flagged;
 *  3. occurrences of the turn's known values (`knownValues`), longest first.
 *
 * A throwing detector propagates: the caller must withhold, never forward.
 */
export async function redactToolErrorSpans(
  text: string,
  detectors: readonly PromptPiiDetector[],
  knownValues: Iterable<string>,
): Promise<ToolErrorRedaction> {
  const detected = await collectDetectorSpans(text, detectors);
  const resolved = dedupSpans(text, detected);
  const replacements: Replacement[] = resolved.map((s) => ({
    start: s.start,
    end: s.end,
    type: s.type,
  }));
  const spans: PromptMaskedSpanInfo[] = resolved.map((s) => ({
    type: s.type,
    detector: s.detector,
  }));

  const sweep = new Map<string, string>();
  for (const s of resolved) if (!sweep.has(s.value)) sweep.set(s.value, s.type);
  const detectedValues = new Set(sweep.keys());
  for (const value of knownValues) {
    if (value.length > 0 && !sweep.has(value)) sweep.set(value, KNOWN_VALUE_SPAN_TYPE);
  }
  for (const [value, type] of [...sweep.entries()].sort((a, b) => b[0].length - a[0].length)) {
    let from = text.indexOf(value);
    while (from >= 0) {
      const end = from + value.length;
      if (!overlapsAny(from, end, replacements)) {
        replacements.push({ start: from, end, type });
        if (!detectedValues.has(value)) {
          spans.push({ type, detector: KNOWN_VALUE_DETECTOR });
        }
      }
      from = text.indexOf(value, end);
    }
  }

  let out = text;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + markerFor(r.type) + out.slice(r.end);
  }
  return { text: out, spans, values: [...sweep.keys()] };
}
