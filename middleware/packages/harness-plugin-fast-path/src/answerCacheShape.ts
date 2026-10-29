import { isDeepStrictEqual } from 'node:util';

import { normalizeQuestion, stripLiterals } from './literalStripping.js';
import type { RefreshSource } from './refreshRecipes.js';
import type { PlannedQuery } from './triage.js';

/**
 * Zero-LLM answer cache — the question SHAPE and its slots (pure functions).
 *
 * A cache entry maps a normalised question shape to the plan that answered
 * it: "offene posten von {{text_1}}" → the odoo_query whose `{{text_1}}` is
 * the partner name. The shape is the question normalised exactly like a
 * learned example (normalizeQuestion: lowercase, punctuation stripped,
 * whitespace collapsed); every user literal the PLAN used verbatim becomes
 * the plan's own placeholder (stripLiterals numbering). A later question
 * hits only on an EXACT token match of every non-slot word; each slot is
 * then filled from the new question's raw text at the same position.
 *
 * Built conservatively — anything that could replay a stale or wrong query
 * is "not cacheable", never a guess:
 *   - every placeholder of the plan must occur exactly once in the question
 *     (else it could not be filled later), slots never adjacent;
 *   - a slot span is 1..MAX_SLOT_TOKENS tokens, none of them a structure
 *     word (preposition, month, relative-time word, …) — so "rechnungen von
 *     müller im januar" can never fill `{{text_1}}` with "müller im januar";
 *   - dates must be relative tokens (`{today…}`) unless the question states
 *     them literally; a relative-time question ("diesen Monat") never caches
 *     a plan with a literal date or a datePart filter;
 *   - the entry must reproduce the original plan EXACTLY from the original
 *     question (round trip), so every transform is proven before storing.
 */

/** Max tokens one slot may span (a name, a city, a company). */
export const MAX_SLOT_TOKENS = 4;

export type SlotValueType = 'string' | 'number';

export interface CacheSlot {
  /** the plan placeholder (`{{text_1}}`, `{{email_1}}`, `{{id_1}}`) */
  placeholder: string;
  type: SlotValueType;
  /** string slots: how the question span becomes the literal */
  letterCase?: 'keep' | 'lower' | 'upper';
  /** wildcard affixes around the span (`%` of an ilike pattern) */
  prefix?: string;
  suffix?: string;
}

/** The literal-stripped plan of an entry (placeholders still in). */
export interface CachedPlan {
  fetch: RefreshSource;
  labels: Record<string, string>;
  summary: string;
  locale?: string;
}

/** What a stored entry needs (without bookkeeping). */
export interface CacheShape {
  key: string;
  plan: CachedPlan;
  slots: CacheSlot[];
}

export type ShapeResult = { ok: true; shape: CacheShape } | { ok: false; reason: string };

/** One token of the normalised question with its raw-text span. */
interface Token {
  norm: string;
  start: number;
  end: number;
}

const RAW_TOKEN = /[\p{L}\p{N}@.-]+/gu;

/**
 * The tokens of `normalizeQuestion(raw)` with their offsets in `raw`;
 * undefined when the two disagree (an exotic case mapping) — the caller
 * then treats the question as uncacheable.
 */
export function tokenize(raw: string): Token[] | undefined {
  const tokens: Token[] = [];
  for (const m of raw.matchAll(RAW_TOKEN)) {
    const text = m[0];
    const lead = /^[.-]*/.exec(text)?.[0].length ?? 0;
    const trail = /[.-]*$/.exec(text.slice(lead))?.[0].length ?? 0;
    const core = text.slice(lead, text.length - trail);
    if (core.length === 0) continue;
    const start = (m.index ?? 0) + lead;
    tokens.push({ norm: core.toLowerCase(), start, end: start + core.length });
  }
  return tokens.map((t) => t.norm).join(' ') === normalizeQuestion(raw) ? tokens : undefined;
}

const SLOT_STOPWORDS: ReadonlySet<string> = new Set(
  (
    // German function words, question words, verbs of asking
    'von vom im in am an auf aus bei mit für fuer nach seit bis über ueber unter zwischen vor um ab ' +
    'und oder sowie nicht kein keine ohne der die das den dem des ein eine einen einem einer ' +
    'alle allen welche welcher welches wie viele was wer wo wann mir mich uns bitte zeige zeig liste ' +
    'gib nenne sind ist hat haben noch nur auch schon offen offene offenen ' +
    // English
    'of on at by for from with to and or not no all which how many much what who where when ' +
    'show list me us please give is are has have only also open the a an ' +
    // months and weekdays
    'januar jänner februar märz maerz april mai juni juli august september oktober november dezember ' +
    'january february march may june july october december ' +
    'montag dienstag mittwoch donnerstag freitag samstag sonntag ' +
    'monday tuesday wednesday thursday friday saturday sunday'
  ).split(' '),
);

/** Words that make a question relative to the day it is asked. */
const RELATIVE_TIME: ReadonlySet<string> = new Set(
  (
    'heute gestern morgen vorgestern übermorgen jetzt aktuell aktuelle aktuellen derzeit bisher ' +
    'diese diesen dieser diesem dieses letzte letzten letzter letztem letztes nächste nächsten nächster ' +
    'nächstem nächstes naechste naechsten kommende kommenden kommender vergangene vergangenen ' +
    'laufende laufenden seit vor überfällig überfällige überfälligen ' +
    'today yesterday tomorrow now current currently this last next past recent recently upcoming ago since overdue'
  ).split(' '),
);

/** Openers that make a turn lean on the previous query ("und im Februar?"). */
const FOLLOW_UP_OPENERS: ReadonlySet<string> = new Set([
  'und', 'and', 'oder', 'or', 'auch', 'also', 'dasselbe', 'same', 'nur', 'only', 'jetzt', 'now',
  'davon', 'dazu', 'stattdessen', 'instead', 'ebenso', 'genauso',
]);
/** Two-word openers asking about "the same, but …" ("wie ist es mit …"). */
const FOLLOW_UP_PAIRS: ReadonlySet<string> = new Set(['wie ist', 'wie sieht', 'what about', 'how about']);
const ANAPHORA: ReadonlySet<string> = new Set([
  'davon', 'dazu', 'diese', 'dieser', 'dieses', 'denen', 'deren', 'those', 'these', 'them', 'ebenso',
]);

/**
 * A turn whose meaning may depend on the previous query: it opens with a
 * follow-up word (und/and/auch/…), uses an anaphor (davon/those/…) or has
 * fewer than two words. Such a turn is never cached or looked up.
 */
export function isFollowUpShaped(question: string): boolean {
  const words = normalizeQuestion(question).split(' ').filter((w) => w.length > 0);
  if (words.length < 2) return true;
  if (FOLLOW_UP_OPENERS.has(words[0]!) || FOLLOW_UP_PAIRS.has(`${words[0]} ${words[1]}`)) return true;
  return words.some((w) => ANAPHORA.has(w));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const YEAR_LIKE_MIN = 1900;
const YEAR_LIKE_MAX = 2100;

/** Collect the date literals, year-like numbers and datePart filters of a
 *  template — what could have been derived from "now". */
function timeFacts(template: unknown, key?: string, out = { dates: [] as string[], years: [] as number[], dateParts: 0 }) {
  if (typeof template === 'string') {
    if (ISO_DATE.test(template)) out.dates.push(template);
  } else if (typeof template === 'number') {
    if (key !== 'limit' && key !== 'take' && Number.isInteger(template) && template >= YEAR_LIKE_MIN && template <= YEAR_LIKE_MAX) {
      out.years.push(template);
    }
  } else if (Array.isArray(template)) {
    for (const v of template) timeFacts(v, key, out);
  } else if (typeof template === 'object' && template !== null) {
    const o = template as Record<string, unknown>;
    if (typeof o['datePart'] === 'string') out.dateParts += 1;
    for (const [k, v] of Object.entries(o)) timeFacts(v, k, out);
  }
  return out;
}

/** Why the plan's time semantics could go stale when replayed, else null. */
function staleTimeReason(fetch: RefreshSource, tokens: readonly Token[], raw: string): string | null {
  const facts = timeFacts({ input: fetch.input, filter: fetch.filter ?? null });
  const words = new Set(tokens.map((t) => t.norm));
  if (facts.dates.some((d) => !raw.includes(d))) return 'derived-date';
  if (facts.years.some((y) => !words.has(String(y)))) return 'derived-year';
  const relative = tokens.some((t) => RELATIVE_TIME.has(t.norm));
  if (relative && (facts.dates.length > 0 || facts.dateParts > 0)) return 'relative-literal-date';
  return null;
}

const WILDCARD_AFFIX = /^[%*_]*$/;

/** How raw span `span` becomes `literal`, or undefined when it does not. */
function slotTransform(literal: string | number, span: string): Omit<CacheSlot, 'placeholder'> | undefined {
  if (typeof literal === 'number') {
    return /^\d{1,15}$/.test(span) && Number(span) === literal ? { type: 'number' } : undefined;
  }
  const variants: Array<[CacheSlot['letterCase'], string]> = [
    ['keep', span],
    ['lower', span.toLowerCase()],
    ['upper', span.toUpperCase()],
  ];
  for (const [letterCase, v] of variants) {
    const at = literal.indexOf(v);
    if (at < 0) continue;
    const prefix = literal.slice(0, at);
    const suffix = literal.slice(at + v.length);
    if (!WILDCARD_AFFIX.test(prefix) || !WILDCARD_AFFIX.test(suffix)) continue;
    return {
      type: 'string',
      letterCase,
      ...(prefix.length > 0 ? { prefix } : {}),
      ...(suffix.length > 0 ? { suffix } : {}),
    };
  }
  return undefined;
}

/** Every start index at which `needle` occurs in `hay` (token-wise). */
function occurrences(hay: readonly string[], needle: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    if (needle.every((t, j) => hay[i + j] === t)) out.push(i);
  }
  return out;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with every case-insensitive, whole-word occurrence of `span`
 *  replaced (never inside a longer word: span "ag" leaves "Tage" alone). */
function replaceSpan(text: string, span: string, by: string): string {
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(span)}(?![\\p{L}\\p{N}])`, 'giu'), by);
}

/** Deep copy of `value` with whole-string placeholders replaced by `fill`. */
function fillTemplate(value: unknown, fill: ReadonlyMap<string, string | number>): unknown {
  if (typeof value === 'string') return fill.has(value) ? fill.get(value) : value;
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, fill));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, fill)]));
  }
  return value;
}

/** `text` with every slot placeholder replaced by its raw question span. */
function fillText(text: string, spans: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [ph, span] of spans) out = out.split(ph).join(span);
  return out;
}

/**
 * The cache shape of a hit: `question` (raw) answered by `plan` (concrete
 * values). Not cacheable → a reason (never the question or a value).
 */
export function buildCacheShape(question: string, plan: PlannedQuery): ShapeResult {
  const no = (reason: string): ShapeResult => ({ ok: false, reason });
  const tokens = tokenize(question);
  if (tokens === undefined || tokens.length === 0) return no('untokenizable');
  const stale = staleTimeReason(plan.fetch, tokens, question);
  if (stale !== null) return no(stale);
  const { template, literals } = stripLiterals({ input: plan.fetch.input, filter: plan.fetch.filter ?? null });
  const t = template as { input: unknown; filter: RefreshSource['filter'] | null };
  const norms = tokens.map((tk) => tk.norm);
  const slotAt = new Map<number, { placeholder: string; length: number }>();
  const slots: CacheSlot[] = [];
  const spanOf = new Map<string, string>();
  for (const [placeholder, literal] of literals) {
    const needle = normalizeQuestion(String(literal)).split(' ').filter((w) => w.length > 0);
    if (needle.length === 0 || needle.length > MAX_SLOT_TOKENS) return no('slot-length');
    if (needle.some((w) => SLOT_STOPWORDS.has(w) || RELATIVE_TIME.has(w))) return no('slot-structure-word');
    const at = occurrences(norms, needle);
    if (at.length !== 1) return no(at.length === 0 ? 'slot-not-in-question' : 'slot-ambiguous');
    const start = at[0]!;
    const span = question.slice(tokens[start]!.start, tokens[start + needle.length - 1]!.end);
    const transform = slotTransform(literal, span);
    if (transform === undefined) return no('slot-transform');
    slotAt.set(start, { placeholder, length: needle.length });
    slots.push({ placeholder, ...transform });
    spanOf.set(placeholder, span);
  }
  // key: tokens with each slot span collapsed to its placeholder
  const keyParts: string[] = [];
  let lastWasSlot = false;
  for (let i = 0; i < norms.length; ) {
    const slot = slotAt.get(i);
    if (slot !== undefined) {
      if (lastWasSlot) return no('adjacent-slots');
      keyParts.push(slot.placeholder);
      i += slot.length;
      lastWasSlot = true;
      continue;
    }
    if (norms[i]!.includes('{{')) return no('untokenizable');
    keyParts.push(norms[i]!);
    lastWasSlot = false;
    i += 1;
  }
  if (keyParts.length - slots.length < 1) return no('no-fixed-words');
  // summary + labels: the slot spans the planner echoed become placeholders
  const strip = (text: string): string =>
    [...spanOf].reduce((acc, [ph, span]) => replaceSpan(acc, span, ph), text);
  const cached: CachedPlan = {
    fetch: {
      ...plan.fetch,
      input: t.input,
      ...(t.filter ? { filter: t.filter } : {}),
    },
    labels: Object.fromEntries(Object.entries(plan.labels).map(([k, v]) => [k, strip(v)])),
    summary: strip(plan.summary),
    ...(plan.locale !== undefined ? { locale: plan.locale } : {}),
  };
  const words = new Set(norms);
  const presentation = [cached.summary, ...Object.values(cached.labels)].join(' ').replace(/\{[^}]*\}+/g, ' ');
  if ((presentation.match(/\d+/g) ?? []).some((d) => !words.has(d))) return no('derived-number-in-text');
  const shape: CacheShape = { key: keyParts.join(' '), plan: cached, slots };
  // round trip: the entry must rebuild the ORIGINAL plan from the question
  const replay = fillShape(shape, question);
  if (!replay.ok) return no(`round-trip:${replay.reason}`);
  const original = { fetch: plan.fetch, labels: plan.labels, summary: plan.summary };
  if (!isDeepStrictEqual(replay.filled, original)) return no('round-trip-mismatch');
  return { ok: true, shape };
}

type KeyPart = { slot: CacheSlot } | { word: string };

/** Every assignment of slot spans that makes `norms` match `parts`. */
function matchParts(parts: readonly KeyPart[], norms: readonly string[]): Array<Array<[number, number]>> {
  const found: Array<Array<[number, number]>> = [];
  const walk = (pi: number, ti: number, acc: Array<[number, number]>): void => {
    if (found.length > 1) return; // ambiguity is all we need to know
    if (pi === parts.length) {
      if (ti === norms.length) found.push([...acc]);
      return;
    }
    const part = parts[pi]!;
    if ('word' in part) {
      if (norms[ti] === part.word) walk(pi + 1, ti + 1, acc);
      return;
    }
    for (let len = 1; len <= MAX_SLOT_TOKENS && ti + len <= norms.length; len += 1) {
      const span = norms.slice(ti, ti + len);
      if (span.some((w) => SLOT_STOPWORDS.has(w) || RELATIVE_TIME.has(w))) break;
      acc.push([ti, ti + len]);
      walk(pi + 1, ti + len, acc);
      acc.pop();
    }
  };
  walk(0, 0, []);
  return found;
}

export type FillResult =
  | {
      ok: true;
      filled: { fetch: RefreshSource; labels: Record<string, string>; summary: string };
      /** raw-text [start, end) of every slot span in the question */
      slotSpans: Array<[number, number]>;
    }
  | { ok: false; reason: string };

/**
 * Fill `shape`'s slots from `question` — exact match of every fixed word,
 * exactly ONE way to place the slots, each value of its slot's type.
 */
export function fillShape(shape: CacheShape, question: string): FillResult {
  const no = (reason: string): FillResult => ({ ok: false, reason });
  const tokens = tokenize(question);
  if (tokens === undefined) return no('untokenizable');
  const bySlot = new Map(shape.slots.map((s) => [s.placeholder, s]));
  const parts: KeyPart[] = shape.key.split(' ').map((w) => {
    const slot = bySlot.get(w);
    return slot !== undefined ? { slot } : { word: w };
  });
  const matches = matchParts(
    parts,
    tokens.map((t) => t.norm),
  );
  if (matches.length === 0) return no('shape-mismatch');
  if (matches.length > 1) return no('slot-ambiguous');
  const ranges = matches[0]!;
  const fill = new Map<string, string | number>();
  const spans = new Map<string, string>();
  const slotSpans: Array<[number, number]> = [];
  let r = 0;
  for (const part of parts) {
    if (!('slot' in part)) continue;
    const [from, to] = ranges[r]!;
    r += 1;
    const span = question.slice(tokens[from]!.start, tokens[to - 1]!.end);
    slotSpans.push([tokens[from]!.start, tokens[to - 1]!.end]);
    const slot = part.slot;
    if (slot.type === 'number') {
      if (!/^\d{1,15}$/.test(span)) return no('slot-type');
      fill.set(slot.placeholder, Number(span));
    } else {
      if (slot.placeholder.startsWith('{{email_') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(span)) return no('slot-type');
      if (slot.placeholder.startsWith('{{id_') && !/^\d+$/.test(span)) return no('slot-type');
      const cased = slot.letterCase === 'lower' ? span.toLowerCase() : slot.letterCase === 'upper' ? span.toUpperCase() : span;
      fill.set(slot.placeholder, `${slot.prefix ?? ''}${cased}${slot.suffix ?? ''}`);
    }
    spans.set(slot.placeholder, span);
  }
  const { input, filter, ...rest } = shape.plan.fetch;
  const fetch: RefreshSource = {
    ...rest,
    input: fillTemplate(input, fill),
    ...(filter !== undefined ? { filter: fillTemplate(filter, fill) as RefreshSource['filter'] } : {}),
  };
  return {
    ok: true,
    filled: {
      fetch,
      labels: Object.fromEntries(Object.entries(shape.plan.labels).map(([k, v]) => [k, fillText(v, spans)])),
      summary: fillText(shape.plan.summary, spans),
    },
    slotSpans,
  };
}
