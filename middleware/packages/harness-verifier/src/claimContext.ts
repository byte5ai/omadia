/**
 * #129 — the enclosing sentence of a claim, cut deterministically from the
 * answer (no LLM). The claim extractor attaches it to fragment claims; the
 * evidence judge, which never sees the whole answer, reads it to know whom a
 * fragment is about.
 */

export const MAX_CONTEXT_CHARS = 400;

/** Tokens whose trailing dot does not end a sentence: ordinals ("1.", "3."),
 *  and the common German/English abbreviations an ERP answer uses. */
const NON_TERMINAL_BEFORE_DOT = /(?:\d+|z\.b|d\.h|u\.a|bzw|ca|dr|prof|nr|str|evtl|ggf|inkl|exkl|vgl|etc|usw|vs|abs|art|no|approx|e\.g|i\.e)$/i;

/**
 * #129 — the sentence of `answer` that contains `text` (case-insensitive),
 * or `undefined` when `text` is absent, already spans the whole sentence,
 * or occurs in more than one sentence (then we would only be guessing
 * which subject the fragment belongs to — better no context than a wrong
 * one, which could turn an `unverified` into a false `contradicted`).
 *
 * Sentence boundaries are `.`, `!`, `?` followed by whitespace/end, or a
 * newline; a dot after a number or a known abbreviation ("01.03.2023",
 * "1. März", "z.B.", "Dr.") is not a boundary. Pure string work, no LLM:
 * the extractor sometimes emits a subject-less fragment ("in die
 * IT-Abteilung") and the judge, which never sees the answer, needs the
 * enclosing sentence to know *who* moved where.
 */
export function claimContext(text: string, answer: string): string | undefined {
  const found = locate(text, answer);
  if (!found) return undefined;
  const { needle, at, bounds } = found;
  let [s, e] = bounds;
  if (e - s > MAX_CONTEXT_CHARS) {
    // Over-long sentence: keep a window around the span, not its head.
    const room = Math.floor((MAX_CONTEXT_CHARS - needle.length) / 2);
    s = Math.max(s, at - room);
    e = Math.min(e, at + needle.length + room);
  }
  const sentence = answer.slice(s, e).trim();
  if (sentence.length === 0) return undefined;
  if (stripTrailingPunctuation(sentence.toLowerCase()) === stripTrailingPunctuation(needle)) {
    return undefined;
  }
  return sentence;
}

/**
 * Where the span `text` stands in `answer`: its first offset and the
 * `[start, end)` of the one sentence that holds it — found the way
 * {@link claimContext} finds it (case-insensitive; undefined when the span
 * is absent, or occurs again in another sentence).
 */
export function claimLocation(
  text: string,
  answer: string,
): { readonly at: number; readonly sentence: readonly [number, number] } | undefined {
  const found = locate(text, answer);
  return found ? { at: found.at, sentence: found.bounds } : undefined;
}

function locate(
  text: string,
  answer: string,
): { needle: string; at: number; bounds: [number, number] } | undefined {
  const needle = text.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  const hay = answer.toLowerCase();
  // Lower-casing can change the code-unit length (e.g. U+0130) and would
  // shift every offset — bail out rather than slice at the wrong place.
  if (hay.length !== answer.length) return undefined;
  const at = hay.indexOf(needle);
  if (at < 0) return undefined;
  const bounds = sentenceBounds(answer, at, needle.length);
  const again = hay.indexOf(needle, at + 1);
  if (again >= 0 && again >= bounds[1]) return undefined; // second occurrence in another sentence
  return { needle, at, bounds };
}

/** `[start, end)` of the sentence containing the span `[at, at+len)`. */
function sentenceBounds(s: string, at: number, len: number): [number, number] {
  let start = at;
  while (start > 0 && !isSentenceBoundaryBefore(s, start)) start -= 1;
  let end = at + len;
  while (end < s.length && !isSentenceBoundaryAfter(s, end)) end += 1;
  return [start, end];
}

/** True when position `i` starts a new sentence (previous char ends one). */
function isSentenceBoundaryBefore(s: string, i: number): boolean {
  const prev = s[i - 1];
  if (prev === '\n') return true;
  if (prev !== '.' && prev !== '!' && prev !== '?') return false;
  if (!/\s/.test(s[i] ?? ' ')) return false;
  return prev !== '.' || !NON_TERMINAL_BEFORE_DOT.test(s.slice(Math.max(0, i - 8), i - 1));
}

/** True when position `i` (exclusive end) closes a sentence — `i` is the
 *  index just past the terminator. */
function isSentenceBoundaryAfter(s: string, i: number): boolean {
  const ch = s[i - 1];
  if (s[i] === '\n') return true;
  if (ch !== '.' && ch !== '!' && ch !== '?') return false;
  if (!(i >= s.length || /\s/.test(s[i] ?? ''))) return false;
  return ch !== '.' || !NON_TERMINAL_BEFORE_DOT.test(s.slice(Math.max(0, i - 9), i - 1));
}

function stripTrailingPunctuation(v: string): string {
  return v.replace(/[.!?\s]+$/u, '');
}
