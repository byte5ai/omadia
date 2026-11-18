/**
 * Tolerant JSON-object extraction for fast-model answers (canvas composer,
 * in-place planner, chat triage). Models asked for "raw JSON only" still
 * wrap the object in markdown fences, put a sentence in front of it, append
 * a remark after it or emit a second object. The FIRST balanced top-level
 * JSON object is the answer; everything around it is dropped. Validation of
 * the object itself stays with the caller (schema, whitelist) — this only
 * finds it.
 */

/** How the object sat in the raw output (PII-free, for logs). */
export type JsonOutputShape =
  /** the output IS the object (after trimming) */
  | 'raw'
  /** recovered from fences / surrounding text / a second object */
  | 'recovered'
  /** no output at all */
  | 'empty'
  /** an object starts but never closes — typically a max-tokens cut */
  | 'unbalanced'
  /** text without any parseable object */
  | 'no-object';

export type ExtractedJson =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly shape: 'raw' | 'recovered' }
  | { readonly ok: false; readonly shape: Exclude<JsonOutputShape, 'raw' | 'recovered'> };

/** Candidate starts tried before giving up — bounds pathological inputs. */
const MAX_CANDIDATES = 64;

function asObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Index of the `}` closing the object opened at `start`, string-aware;
 *  -1 when it never closes. */
function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The first balanced top-level JSON object in `raw`. */
export function extractFirstJsonObject(raw: string): ExtractedJson {
  const s = raw.trim();
  if (s.length === 0) return { ok: false, shape: 'empty' };
  const whole = asObject(s);
  if (whole) return { ok: true, value: whole, shape: 'raw' };
  let sawUnbalanced = false;
  let from = 0;
  for (let n = 0; n < MAX_CANDIDATES; n += 1) {
    const start = s.indexOf('{', from);
    if (start < 0) break;
    const end = balancedEnd(s, start);
    if (end < 0) {
      sawUnbalanced = true;
      break;
    }
    const value = asObject(s.slice(start, end + 1));
    if (value) return { ok: true, value, shape: 'recovered' };
    // past the whole braced span: a nested object of a broken outer one is
    // never taken for the answer
    from = end + 1;
  }
  return { ok: false, shape: sawUnbalanced ? 'unbalanced' : 'no-object' };
}
