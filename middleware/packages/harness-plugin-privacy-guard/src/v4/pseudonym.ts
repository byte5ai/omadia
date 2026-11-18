/**
 * Privacy Shield v4 — Pseudonym Projection (US7).
 *
 * The gated fallback for the rare case where the LLM must reason in prose
 * about specific individuals. `sensitive-masked` field values are replaced by
 * stable, realistic pseudonyms; the pseudonym↔real map is held server-side and
 * resolved back at materialization (FR-020/FR-021). A generated pseudonym
 * never equals a real value in the dataset (research C5).
 *
 * This module is the mechanism. Wiring it into a concrete prose-reasoning
 * flow is gated on research C6 (scope the real demand from transcripts before
 * over-building) and is therefore intentionally left to a follow-up.
 *
 * Contract: specs/001-privacy-shield-v4/contracts/verb-api.md §5
 */

import type { Dataset, DatasetRow, PseudonymMap } from './types.js';
import { asValueLiteral, findValueLiterals, type ValueLiteral } from '../valueLiterals.js';

// Realistic German-style name pools — the dataset domain is German HR.
// #1545 — a part of a person surrogate ("Hallo Lukas", "Herr Becker") is
// restored on its own, so no pool name may be an ordinary word or
// abbreviation a model writes for its own sake: "Jan" (January), "Max",
// "Richter", "Klein", "Wolf", "Schwarz", "Braun", "Lange", "Krause",
// "Frank", "Vogel" and "Sommer" are gone. Both pools stay 24 long.
export const FIRST_NAMES: ReadonlyArray<string> = [
  'Lukas', 'Mia', 'Felix', 'Emma', 'Jonas', 'Hannah', 'Paul', 'Lena',
  'Tim', 'Sophie', 'Finn', 'Clara', 'Noah', 'Laura', 'Elias', 'Marie',
  'Ben', 'Julia', 'Leon', 'Nina', 'Moritz', 'Sarah', 'Jakob', 'Eva',
];
export const LAST_NAMES: ReadonlyArray<string> = [
  'Becker', 'Schulz', 'Hoffmann', 'Wagner', 'Zimmermann', 'Schmitt', 'Lorenz',
  'Schröder', 'Neumann', 'Seidel', 'Brandt', 'Krüger', 'Hofmann', 'Hartmann',
  'Haas', 'Werner', 'Kühn', 'Lehmann', 'Köhler', 'Maier', 'Pohl',
  'Albrecht', 'Winkler', 'Günther',
];

/**
 * The i-th pool name pair, i < 24 × 24: first name `i mod n`, last name
 * shifted by the block `⌊i / n⌋`. Every pair occurs exactly once, and the
 * first n pairs differ in BOTH names (#1545) — so the first and last name of
 * the people of one turn are each unique and restorable on their own.
 */
function poolPair(i: number): { readonly first: string; readonly last: string } {
  const n = FIRST_NAMES.length;
  return {
    first: FIRST_NAMES[i % n]!,
    last: LAST_NAMES[(i + Math.floor(i / n)) % LAST_NAMES.length]!,
  };
}

const POOL_PAIRS = FIRST_NAMES.length * LAST_NAMES.length;

/** Deterministic stream of "First Last" pseudonym candidates. */
function* pseudonymCandidates(): Generator<string> {
  for (let i = 0; i < POOL_PAIRS; i++) {
    const { first, last } = poolPair(i);
    yield `${first} ${last}`;
  }
}

/**
 * Build a stable pseudonym map for a set of real values. Each distinct real
 * value gets one pseudonym; pseudonyms are distinct and none equals any real
 * value in the set (C5). Deterministic — the same input set yields the same
 * mapping, so a pseudonym is stable for an individual within a turn.
 */
export function createPseudonymMap(
  realValues: Iterable<string>,
): PseudonymMap {
  const reals = [...new Set(realValues)]
    .filter((v) => v.length > 0)
    .sort();
  const realSet = new Set(reals);
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const candidates = pseudonymCandidates();

  for (const real of reals) {
    let pseudonym: string | undefined;
    for (;;) {
      const next = candidates.next();
      if (next.done === true) {
        throw new Error(
          '[privacy-shield-v4] pseudonym pool exhausted — dataset too large',
        );
      }
      const candidate = next.value;
      if (!realSet.has(candidate) && !reverse.has(candidate)) {
        pseudonym = candidate;
        break;
      }
    }
    forward.set(real, pseudonym);
    reverse.set(pseudonym, real);
  }
  return { forward, reverse };
}

/**
 * Project a Dataset for individual-level prose: every `sensitive-masked`
 * string value is replaced by its stable pseudonym. Safe fields are
 * untouched. Returns the projected rows plus the server-held map.
 */
export function projectDataset(dataset: Dataset): {
  rows: DatasetRow[];
  map: PseudonymMap;
} {
  const maskedPaths = dataset.schema.fields
    .filter((f) => f.classification === 'sensitive-masked')
    .map((f) => f.path);

  const reals = new Set<string>();
  for (const row of dataset.rows) {
    for (const path of maskedPaths) {
      const value = row[path];
      if (typeof value === 'string' && value.length > 0) reals.add(value);
    }
  }
  const map = createPseudonymMap(reals);

  const rows = dataset.rows.map((row): DatasetRow => {
    const out: Record<string, unknown> = { ...row };
    for (const path of maskedPaths) {
      const value = row[path];
      if (typeof value === 'string') {
        out[path] = map.forward.get(value) ?? value;
      }
    }
    return out;
  });
  return { rows, map };
}

// ---------------------------------------------------------------------------
// #361 — prompt-span pseudonyms (text-span variant of `createPseudonymMap`).
//
// Free-text prompt masking substitutes DETECTED spans, which are typed
// (email, IBAN, phone, address, amount, date, person) — a "Lukas Becker"
// name surrogate would be shape-wrong for an IBAN and would degrade the
// LLM answer the masking is trying to preserve. Each type therefore draws
// from its own realistic surrogate pool. Same invariants as
// `createPseudonymMap`: deterministic per input set, bijective, and no
// surrogate ever equals a real value or appears in the input text (C5).
// ---------------------------------------------------------------------------

/** A real value + its PII type, as detected in a prompt. */
export interface PromptSpanValue {
  readonly value: string;
  readonly type: string;
}

/** Deterministic per-type surrogate candidate streams. Every generator is
 *  unbounded via a numeric suffix/variation, so the pool cannot exhaust. */
function* personCandidates(): Generator<string> {
  yield* pseudonymCandidates();
  // Overflow beyond the finite name pool: numbered variants.
  for (let i = 2; ; i++) {
    for (let p = 0; p < POOL_PAIRS; p++) {
      const { first, last } = poolPair(p);
      yield `${first} ${last} ${String(i)}`;
    }
  }
}

/** `first.last@example.net` for a "First Last" pool name. */
function poolEmail(first: string, last: string, suffix = ''): string {
  return `${first.toLowerCase()}.${last.toLowerCase()}${suffix}@example.net`;
}

function* emailCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    const { first, last } = poolPair(i % POOL_PAIRS);
    yield i < POOL_PAIRS ? poolEmail(first, last) : poolEmail(first, last, String(i));
  }
}

/** #1554 — e-mail surrogates that name nobody, for an address whose owner
 *  stays readable in clear next to it. Not a reserved shape: the counter is
 *  a free digit slot, so a replayed one is masked again (the safe failure). */
function* neutralEmailCandidates(): Generator<string> {
  for (let i = 1; ; i++) yield `kontakt${String(i)}@example.net`;
}

/** German IBAN shape: 22 characters (#1555 — 21 made the model report a
 *  missing digit in the user's correct IBAN), `DE`, check digits `00` and a
 *  varying 18-digit BBAN. Deliberately NOT checksum-valid — `00` is never a
 *  valid check-digit pair, so it can never collide with a real account, only
 *  look shape-plausible to the model. */
function* ibanCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    // 13 + 4 + 5 characters; the pair of counters repeats only after
    // lcm(9000, 100000) = 900000 candidates.
    yield `DE00500105170${String(1000 + (i % 9000))}${String((20000 + i) % 100000).padStart(5, '0')}`;
  }
}

function* phoneCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    yield `+49 30 5559${String(i % 10000).padStart(4, '0')}`;
  }
}

function* addressCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    yield `Musterstraße ${String(1 + (i % 199))}, ${String(10000 + ((i * 37) % 89999))} Musterstadt`;
  }
}

/** Five-digit amounts 10000–99998. #1577 — no longer a round `€10000` a
 *  real invoice could well carry: a prime stride walks the range, round
 *  hundreds are skipped. 7919 is coprime to 89999, so the first 89999
 *  candidates are pairwise distinct. */
function* amountCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    const amount = 10000 + ((i * 7919 + 2357) % 89999);
    if (amount % 100 !== 0) yield `€${String(amount)}`;
  }
}

/** Plausible recent dates (#1577): years 2003–2022, days 2–27 of any month,
 *  so never the Unix epoch, never a 1st of January and always a calendar day.
 *  A stride coprime to the 26 × 12 × 20 = 6240 slots walks them all before
 *  one repeats. */
const DATE_SLOTS = 26 * 12 * 20;
function* dateCandidates(): Generator<string> {
  for (let i = 0; ; i++) {
    const slot = (i * 1009 + 2851) % DATE_SLOTS;
    const day = 2 + (slot % 26);
    const month = 1 + (Math.floor(slot / 26) % 12);
    const year = 2003 + Math.floor(slot / (26 * 12));
    yield `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${String(year)}`;
  }
}

/** Unknown category from a future detector — neutral placeholder, still
 *  bijective and restorable. */
function* genericCandidates(type: string): Generator<string> {
  for (let i = 0; ; i++) {
    yield `PLATZHALTER-${type.toUpperCase()}-${String(i + 1)}`;
  }
}

function surrogateCandidates(type: string): Generator<string> {
  switch (type) {
    case 'person':
      return personCandidates();
    case 'email':
      return emailCandidates();
    case 'iban':
      return ibanCandidates();
    case 'phone':
      return phoneCandidates();
    case 'address':
      return addressCandidates();
    case 'amount':
      return amountCandidates();
    case 'date':
      return dateCandidates();
    default:
      return genericCandidates(type);
  }
}

/**
 * `target` in the letter case of `sample`: all upper, all lower, or unchanged
 * when `sample` is mixed or has no cased letters. How a surrogate follows the
 * case the user wrote, and how a restored value follows the case the model
 * wrote (#1528).
 */
export function caseLike(sample: string, target: string): string {
  if (sample.toUpperCase() === sample.toLowerCase()) return target;
  if (sample === sample.toUpperCase()) return target.toUpperCase();
  if (sample === sample.toLowerCase()) return target.toLowerCase();
  return target;
}

function isAllUpper(value: string): boolean {
  return value.toUpperCase() !== value.toLowerCase() && value === value.toUpperCase();
}

const NAME_LIKE_LOCAL = /^(\p{L}+)[._](\p{L}+)$/u;

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

/** "jonas.weber" → "Jonas Weber"; undefined when the local part is no name. */
export function nameFromLocalPart(local: string): string | undefined {
  const m = NAME_LIKE_LOCAL.exec(local);
  return m === null ? undefined : `${capitalize(m[1]!)} ${capitalize(m[2]!)}`;
}

const POOL_FIRST: ReadonlySet<string> = new Set(FIRST_NAMES);
const POOL_LAST: ReadonlySet<string> = new Set(LAST_NAMES);

/**
 * The pool first and last name of a person surrogate exactly as the pools
 * mint it ("Lukas Becker", also "LUKAS BECKER"); `undefined` for anything
 * else — a numbered overflow ("Lukas Becker 2"), a placeholder, a real name.
 */
export function personSurrogateParts(
  surrogate: string,
): { readonly first: string; readonly last: string } | undefined {
  const tokens = surrogate.split(' ');
  if (tokens.length !== 2) return undefined;
  const [first, last] = tokens.map(capitalize) as [string, string];
  if (!POOL_FIRST.has(first) || !POOL_LAST.has(last)) return undefined;
  return { first: tokens[0]!, last: tokens[1]! };
}

/** Lower-cased letter/digit runs of `text`. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/**
 * #1554 — the candidate stream for an e-mail value. A name-like local part
 * ("jonas.weber@…") names a person the model may see as well:
 *   - masked this turn as person → that person's surrogate as the address
 *     ("Lukas Becker" → `lukas.becker@example.net`, then numbered variants),
 *     so name and address still agree for the model;
 *   - readable in clear (both name parts are words of the text once every
 *     masked value is cut out) → an address
 *     that names nobody (`kontakt1@example.net`), so the model has no
 *     mismatch to warn about;
 *   - otherwise the pool as before.
 */
function* emailCandidatesFor(
  value: string,
  forward: ReadonlyMap<string, string>,
  clearWords: ReadonlySet<string>,
): Generator<string> {
  const at = value.indexOf('@');
  const name = at > 0 ? nameFromLocalPart(value.slice(0, at)) : undefined;
  if (name === undefined) return yield* emailCandidates();
  const key = name.toLowerCase();
  for (const [real, surrogate] of forward) {
    if (real.toLowerCase() !== key) continue;
    const parts = personSurrogateParts(surrogate);
    if (parts === undefined) continue;
    yield poolEmail(parts.first, parts.last);
    for (let i = 2; i < 10; i++) yield poolEmail(parts.first, parts.last, String(i));
  }
  const [first, last] = wordsOf(name);
  if (first !== undefined && last !== undefined && clearWords.has(first) && clearWords.has(last)) {
    return yield* neutralEmailCandidates();
  }
  return yield* emailCandidates();
}

/** Mint order: persons before everything else, so an e-mail can follow the
 *  person surrogate of its owner (#1554); then by value. */
function mintRank(type: string): number {
  return type === 'person' ? 0 : 1;
}

/** `kind:value` keys of every value a date/amount literal can denote. */
function valueKeys(literals: Iterable<ValueLiteral>): string[] {
  return [...literals].flatMap((literal) => literal.values.map((v) => `${literal.kind}:${v}`));
}

/**
 * The surrogate for a case variant of a value `forward` already holds: that
 * value's surrogate in the variant's case. `undefined` when there is no such
 * value, or when the re-cased surrogate is already taken or equals a real
 * value — a caseless placeholder (`PLATZHALTER-CUSTOM-1`) cannot carry the
 * variant's case, so the variant gets a surrogate of its own and restore
 * gives back exactly what the user wrote.
 */
function caseVariantSurrogate(
  value: string,
  forward: ReadonlyMap<string, string>,
  reverse: ReadonlyMap<string, string>,
  realsLower: ReadonlySet<string>,
  avoid: string,
): string | undefined {
  const key = value.toLowerCase();
  for (const [real, surrogate] of forward) {
    if (real.toLowerCase() !== key) continue;
    const candidate = caseLike(value, surrogate);
    if (reverse.has(candidate) || realsLower.has(candidate.toLowerCase())) return undefined;
    // Never a spelling the text already carries (same rule as a fresh mint).
    if (avoid.includes(candidate.toLowerCase())) return undefined;
    return candidate;
  }
  return undefined;
}

/**
 * Build (or extend) a pseudonym map for detected prompt spans. Guarantees:
 *   - stable: a value already in `existing` keeps its surrogate;
 *   - bijective: no two real values share a surrogate;
 *   - collision-free: a surrogate never equals a real value in the set OR
 *     any real value from an earlier call this turn (`existing`), never
 *     appears as a substring of `avoidText` (the full prompt), and never
 *     collides with an existing surrogate;
 *   - parts-free (#1545): neither name of a person surrogate is a word of
 *     `avoidText` or of a real value, so restoring "Lukas" alone can never
 *     rewrite a word the user wrote;
 *   - value-free (#1577): a date or amount surrogate never denotes a value
 *     that a real value, an earlier surrogate or any date/amount literal of
 *     `avoidText` denotes — so a surrogate the model re-spells ("10.000 €")
 *     names exactly one surrogate and restore can read it back by value.
 * Deterministic for the same inputs, so a person/value is stable within a
 * turn across multiple mask calls (message + ingested attachment tail).
 */
export function createPromptPseudonymMap(
  spanValues: Iterable<PromptSpanValue>,
  avoidText: string,
  existing?: PseudonymMap,
): PseudonymMap {
  const forward = new Map<string, string>(existing?.forward ?? []);
  const reverse = new Map<string, string>(existing?.reverse ?? []);

  // Deduplicate by value.
  const pending = new Map<string, string>();
  for (const { value, type } of spanValues) {
    if (value.length === 0 || forward.has(value)) continue;
    if (!pending.has(value)) pending.set(value, type);
  }
  // Collision domain = ALL real values seen so far this turn: the current
  // call's pending values AND every real already in `existing` from earlier
  // calls (message, ingested tail, recalled context). Without the latter, a
  // later call could mint a surrogate equal to a real value masked earlier
  // in the turn — answer-side restore would then corrupt that span.
  // Compared case-insensitively, like everything below: surrogates that
  // differ only in case would let restore swap two people (#1528 review).
  const realsLower = new Set([...pending.keys(), ...forward.keys()].map((v) => v.toLowerCase()));
  const takenLower = new Set([...reverse.keys()].map((v) => v.toLowerCase()));
  // Case-insensitive, so a surrogate never equals a spelling of the text the
  // model already reads (#1528).
  const avoid = avoidText.toLowerCase();
  const avoidWords = new Set([avoidText, ...realsLower].flatMap(wordsOf));
  // #1554 — the words the model will read in clear: the text without any
  // real value this turn masks (the address itself spells its owner's name).
  const clearWords = new Set(
    wordsOf(
      [...realsLower]
        .sort((a, b) => b.length - a.length)
        .reduce((text, real) => text.split(real).join(' '), avoid),
    ),
  );
  // Built only when a date or an amount is minted: the values named by real
  // values, earlier surrogates and every literal the text carries.
  let takenValues: Set<string> | undefined;
  const valuesTaken = (): Set<string> => {
    takenValues ??= new Set([
      ...valueKeys(
        [...pending.keys(), ...forward.keys(), ...reverse.keys()].flatMap(
          (v) => asValueLiteral(v) ?? [],
        ),
      ),
      ...valueKeys(findValueLiterals(avoidText)),
    ]);
    return takenValues;
  };
  // #1554 security review — a pool address and a person surrogate that spell
  // the same name ("lukas.becker@example.net" next to "Lukas Becker") read to
  // the model as ONE person although they may stand for two, and restore
  // would then join the wrong address to the wrong name. So an address may
  // not spell a person surrogate's name and a person may not get the name an
  // address spells — unless both stand for the same person
  // (`linkedSurrogates`). Compared across the two types only, and by the full
  // name: a numbered overflow address (`lukas.becker2@…`) spells no name, so
  // the candidate streams always reach a free one.
  const spelledName = (surrogate: string): { kind: 'person' | 'email'; name: string } | undefined => {
    const person = personSurrogateParts(surrogate);
    if (person !== undefined) return { kind: 'person', name: `${person.first} ${person.last}`.toLowerCase() };
    const at = surrogate.indexOf('@');
    const name = at > 0 ? nameFromLocalPart(surrogate.slice(0, at)) : undefined;
    return name === undefined ? undefined : { kind: 'email', name: name.toLowerCase() };
  };
  const sharesNameWith = (candidate: string, allowed: ReadonlySet<string>): boolean => {
    const own = spelledName(candidate);
    if (own === undefined) return false;
    return [...reverse.keys()].some((taken) => {
      if (allowed.has(taken.toLowerCase())) return false;
      const other = spelledName(taken);
      return other !== undefined && other.kind !== own.kind && other.name === own.name;
    });
  };
  const isFree = (candidate: string, type: string, value: string): boolean => {
    const lower = candidate.toLowerCase();
    if (takenLower.has(lower) || realsLower.has(lower) || avoid.includes(lower)) return false;
    if (type === 'person') {
      const [first, last] = wordsOf(candidate);
      if (avoidWords.has(first ?? '') || avoidWords.has(last ?? '')) return false;
      return !sharesNameWith(candidate, linkedSurrogates(value));
    }
    if (type === 'email') return !sharesNameWith(candidate, linkedSurrogates(value));
    if (type === 'amount' || type === 'date') {
      const literal = asValueLiteral(candidate);
      const taken = valuesTaken();
      return literal !== undefined && !valueKeys([literal]).some((key) => taken.has(key));
    }
    return true;
  };
  /** The surrogates already standing for the same person as `value`: for an
   *  address whose local part names a masked person, that person's
   *  surrogate; for a person, the surrogates of addresses that name them. */
  const linkedSurrogates = (value: string): ReadonlySet<string> => {
    const linked = new Set<string>();
    const at = value.indexOf('@');
    const ownName = at > 0 ? nameFromLocalPart(value.slice(0, at)) : value;
    if (ownName === undefined) return linked;
    const key = ownName.toLowerCase();
    for (const [real, surrogate] of forward) {
      const realAt = real.indexOf('@');
      const realName = realAt > 0 ? nameFromLocalPart(real.slice(0, realAt)) : real;
      if (realName?.toLowerCase() === key) linked.add(surrogate.toLowerCase());
    }
    return linked;
  };
  const record = (value: string, surrogate: string): void => {
    forward.set(value, surrogate);
    reverse.set(surrogate, value);
    takenLower.add(surrogate.toLowerCase());
    const literal = takenValues === undefined ? undefined : asValueLiteral(surrogate);
    if (literal !== undefined) {
      for (const key of valueKeys([literal])) takenValues?.add(key);
    }
  };

  const ordered = [...pending.entries()].sort(
    (a, b) => mintRank(a[1]) - mintRank(b[1]) || a[0].localeCompare(b[0]),
  );
  for (const [value, type] of ordered) {
    // #1528 — a case variant of a value this turn already masked ("JONAS…"
    // after "jonas…") is the same value: it gets the same surrogate in its
    // own case, so the model does not see two people where there is one.
    const variant = caseVariantSurrogate(value, forward, reverse, realsLower, avoid);
    if (variant !== undefined) {
      record(value, variant);
      continue;
    }
    const candidates =
      type === 'email' ? emailCandidatesFor(value, forward, clearWords) : surrogateCandidates(type);
    let surrogate: string | undefined;
    for (const raw of candidates) {
      // An upper-case value gets an upper-case surrogate, so the model sees
      // the case the user wrote.
      const candidate = isAllUpper(value) ? raw.toUpperCase() : raw;
      if (isFree(candidate, type, value)) {
        surrogate = candidate;
        break;
      }
    }
    // Unreachable: every stream is unbounded — but keep the invariant loud.
    if (surrogate === undefined) {
      throw new Error('[privacy-shield-v4] prompt surrogate pool exhausted');
    }
    record(value, surrogate);
  }
  return { forward, reverse };
}

/**
 * Resolve pseudonyms back to real values in a block of text — the inverse of
 * `projectDataset`, applied at materialization. Longest pseudonyms first so a
 * shorter pseudonym cannot partially rewrite a longer one.
 */
export function resolvePseudonyms(text: string, map: PseudonymMap): string {
  const pairs = [...map.reverse.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  let result = text;
  for (const [pseudonym, real] of pairs) {
    result = result.split(pseudonym).join(real);
  }
  return result;
}
