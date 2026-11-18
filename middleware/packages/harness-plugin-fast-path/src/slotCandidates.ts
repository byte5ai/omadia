import { containsPlaceholder } from './literalStripping.js';

/**
 * Slot filling without a planner (P2): a learned plan with placeholders
 * (`offene posten von {{text_1}}`) runs on a new question once each
 * placeholder has its value. The candidates for that value are cut from the
 * (masked) turn message deterministically here; a decision model then picks
 * which candidate fills which placeholder (turnGate.ts). The picked span is
 * restored through the turn's privacy run before it reaches the query.
 *
 * Candidates are conservative: quoted phrases, e-mail addresses and runs of
 * 1..{@link MAX_SPAN_WORDS} capitalised words (names, companies, cities —
 * `Müller GmbH`, `Frankfurt am Main` is cut as `Frankfurt`). Question words
 * and the fixed vocabulary of the stored question are never candidates.
 */

export const MAX_SPAN_WORDS = 4;
export const MAX_CANDIDATES = 12;
/** Placeholders a plan may have and still be filled without the planner. */
export const MAX_SLOTS = 2;

const SLOT = /\{\{(text|email)_\d+\}\}/g;
const ANY_PLACEHOLDER = /\{\{[a-z]+_\d+\}\}/g;
const QUOTED = /["„“”'‚‘’]([^"„“”'‚‘’]{2,60})["„“”'‚‘’]/g;
const EMAIL = /[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}/g;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}&.'-]*/gu;
/** Legal-form suffixes that continue a company name. */
const COMPANY_SUFFIX = /^(gmbh|ag|kg|ug|se|ohg|gbr|ev|e\.v\.|ltd|inc|llc|co\.?|mbh)$/i;
/** Words that start a question and are capitalised without being a value. */
const STOP: ReadonlySet<string> = new Set([
  'welche', 'welcher', 'welches', 'wie', 'was', 'wer', 'wo', 'wann', 'warum', 'zeig', 'zeige', 'liste', 'gib',
  'bitte', 'alle', 'die', 'der', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'und', 'oder', 'von', 'vom', 'für',
  'mit', 'bei', 'im', 'in', 'am', 'an', 'auf', 'aus', 'zu', 'zum', 'zur', 'ich', 'wir', 'uns', 'mir', 'mein',
  'unsere', 'unser', 'haben', 'hat', 'sind', 'ist', 'gibt', 'es', 'user', 'turn', 'previous', 'query',
  'which', 'what', 'who', 'where', 'when', 'how', 'show', 'list', 'give', 'please', 'all', 'the', 'a', 'an',
  'of', 'for', 'with', 'by', 'from', 'to', 'and', 'or', 'my', 'our', 'we', 'i', 'is', 'are', 'do', 'does',
]);

/** The fillable placeholders of a plan's fetch, in first-seen order. */
export function planSlots(fetch: unknown): string[] {
  const seen: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(ANY_PLACEHOLDER)) if (!seen.includes(m[0])) seen.push(m[0]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
  };
  walk(fetch);
  return seen;
}

/** True when every placeholder of `fetch` is a text/email slot and there are
 *  at most {@link MAX_SLOTS} of them (an `id` slot is never guessed). */
export function isFillable(fetch: unknown): boolean {
  const slots = planSlots(fetch);
  return slots.length <= MAX_SLOTS && slots.every((s) => new RegExp(SLOT.source).test(s));
}

function isCapitalised(word: string): boolean {
  const first = word.charAt(0);
  return first !== first.toLowerCase() && first === first.toUpperCase();
}

/**
 * Value candidates of a (masked) user turn: quoted phrases, e-mails and
 * capitalised word runs, minus stop words and words of `fixedWords` (the
 * stored question's own vocabulary). Unique, in text order, at most
 * {@link MAX_CANDIDATES}.
 */
export function slotCandidates(turn: string, fixedWords: ReadonlySet<string> = new Set()): string[] {
  const text = turn.replace(/^.*?USER TURN:\s*/s, '');
  const out: string[] = [];
  const add = (raw: string): void => {
    const v = raw.trim().replace(/[?!.,;:]+$/, '');
    if (v.length < 2 || out.includes(v) || out.length >= MAX_CANDIDATES) return;
    out.push(v);
  };
  for (const m of text.matchAll(QUOTED)) add(m[1] ?? '');
  for (const m of text.matchAll(EMAIL)) add(m[0]);
  const words = [...text.matchAll(WORD)].map((m) => m[0]);
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) add(run.join(' '));
    run = [];
  };
  for (const w of words) {
    const lower = w.toLowerCase();
    const isValueWord = (isCapitalised(w) || /\d/.test(w)) && !STOP.has(lower) && !fixedWords.has(lower);
    if (isValueWord || (run.length > 0 && COMPANY_SUFFIX.test(w))) {
      run.push(w);
      if (run.length >= MAX_SPAN_WORDS) flush();
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** The lower-case words of a stored (literal-stripped) question, without its
 *  placeholders — the fixed vocabulary a candidate must not be. */
export function fixedVocabulary(examples: readonly string[]): Set<string> {
  const words = new Set<string>();
  for (const e of examples) {
    for (const m of e.replace(ANY_PLACEHOLDER, ' ').matchAll(WORD)) words.add(m[0].toLowerCase());
  }
  return words;
}

/** `fetch` with every placeholder replaced by its value (string leaves only;
 *  a `%{{text_1}}%` ilike pattern keeps its wildcards). Undefined when a
 *  placeholder is left. */
export function fillSlots<T>(fetch: T, values: ReadonlyMap<string, string>): T | undefined {
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(ANY_PLACEHOLDER, (p) => values.get(p) ?? p);
    if (Array.isArray(v)) return v.map(fill);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    }
    return v;
  };
  const filled = fill(fetch) as T;
  return containsPlaceholder(filled) ? undefined : filled;
}
