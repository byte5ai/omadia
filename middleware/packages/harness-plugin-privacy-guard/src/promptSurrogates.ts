/**
 * #1528 / #1529 — how prompt surrogates are recognized in text the shield did
 * not write itself: a model answer to restore, or a text about to be masked.
 *
 * Three jobs, one module, because they share the same notion of "a form of a
 * surrogate":
 *
 *   - `resolvePromptPseudonyms` restores surrogates the model rewrote: a
 *     different case ("LUKAS.BECKER@EXAMPLE.NET"), the local part of an e-mail
 *     surrogate ("lukas.becker@…") and the name read out of it ("Lukas
 *     Becker"), a first or last name of a person surrogate alone ("Hallo
 *     Lukas", "Herr Becker" — #1545) and a date or amount surrogate in another
 *     spelling ("10.000 €" — #1577). The exact form is still the first choice;
 *     variants only match on word boundaries.
 *   - `isReservedSurrogateShape` names the surrogate shapes that can never be a
 *     real value (RFC 2606 `example.net` mail, `PLATZHALTER-…`, `Musterstadt`,
 *     IBANs with check digits `00`). A replayed answer that still carries one
 *     must not be masked again as if it were a new real value.
 *   - `protectedRanges` / `findResidualRealValues` keep the shield's own
 *     placeholders out of the leak check: the deny-list term `CUSTOM` occurs in
 *     `PLATZHALTER-CUSTOM-1` without anything of the user's text being there.
 *
 * Person names, phone numbers, amounts and dates have realistic surrogates, so
 * none of them is a reserved shape: a real "Lukas Becker" must still be masked.
 */

import {
  caseLike,
  FIRST_NAMES,
  LAST_NAMES,
  nameFromLocalPart,
  personSurrogateParts,
} from './v4/pseudonym.js';
import type { IdentityLeak } from './v4/onTheWire.js';
import type { PseudonymMap } from './v4/types.js';
import { asValueLiteral, findValueLiterals } from './valueLiterals.js';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD = /[\p{L}\p{N}_]/u;

/** True when `text[start, end)` is not glued to a letter, digit or `_`. */
function onWordBoundaries(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1]! : '';
  const after = end < text.length ? text[end]! : '';
  return !(before !== '' && WORD.test(before)) && !(after !== '' && WORD.test(after));
}

// ---------------------------------------------------------------------------
// Reserved surrogate shapes.
// ---------------------------------------------------------------------------

const NAME_POOLS = {
  first: FIRST_NAMES.map((n) => escapeRegExp(n.toLowerCase())).join('|'),
  last: LAST_NAMES.map((n) => escapeRegExp(n.toLowerCase())).join('|'),
};

interface ReservedShape {
  readonly source: string;
  readonly flags: string;
}

/**
 * The surrogate shapes no real value can have (see module doc). Mirrors the
 * generators in `v4/pseudonym.ts`, and only what they mint, with no room for
 * user data: user text that merely resembles a shape
 * (`PLATZHALTER-Röntgen-1`, `mia.wolf654321@example.net`) is masked as usual.
 * Shapes with free digits (the numbered e-mail overflow, the Musterstadt
 * address, the `DE00…` IBAN) are deliberately not reserved: a deny-list
 * pattern on digits could hide in them. Re-masking one is the safe failure.
 */
const RESERVED_SHAPES: readonly ReservedShape[] = [
  // RFC 2606 reserves example.net; the local part is a pool name.
  {
    source: String.raw`(?<![\p{L}\p{N}._%+-])(?:${NAME_POOLS.first})\.(?:${NAME_POOLS.last})@example\.net(?![\p{L}\p{N}])`,
    flags: 'iu',
  },
  // The neutral placeholder, for the types that fall back to it: the
  // deny-list (`custom`), caller-named values (`name`) and ID numbers. Upper
  // case exactly as minted; a short counter.
  { source: String.raw`PLATZHALTER-(?:CUSTOM|NAME|IDNUM)-\d{1,3}(?!\p{N})`, flags: 'u' },
];

const RESERVED_SHAPES_ANCHORED: readonly RegExp[] = RESERVED_SHAPES.map(
  ({ source, flags }) => new RegExp(`^(?:${source})$`, flags),
);

/** True when `value` has the shape of a surrogate the shield mints and that no
 *  real value can have. Such a value carries nothing of the user's data. */
export function isReservedSurrogateShape(value: string): boolean {
  const trimmed = value.trim();
  return RESERVED_SHAPES_ANCHORED.some((re) => re.test(trimmed));
}

// ---------------------------------------------------------------------------
// Protected ranges and the residual check.
// ---------------------------------------------------------------------------

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Where `text` holds a surrogate: one this map minted (exactly as minted —
 * a case variant has a surrogate of its own) or a reserved surrogate shape
 * from an earlier turn. Sorted, may overlap.
 */
export function protectedRanges(text: string, map: PseudonymMap | undefined): TextRange[] {
  const ranges: TextRange[] = [];
  const shapes = [...RESERVED_SHAPES];
  if (map !== undefined) {
    for (const surrogate of map.reverse.keys()) {
      if (surrogate.length > 0) shapes.push({ source: escapeRegExp(surrogate), flags: 'u' });
    }
  }
  for (const { source, flags } of shapes) {
    for (const match of text.matchAll(new RegExp(source, `g${flags}`))) {
      if (match.index === undefined || match[0].length === 0) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** True when `[start, end)` lies entirely inside one of `ranges`. Only such
 *  an occurrence is part of a surrogate; one that merely overlaps a range
 *  edge carries text of its own ("Lukas Beckermann" around the surrogate
 *  "Lukas Becker") and must be masked. */
export function insideAny(start: number, end: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((r) => r.start <= start && end <= r.end);
}

/**
 * The post-mask invariant: every real value of `map` that still occurs in
 * `maskedText` OUTSIDE a surrogate. A deny-list term that happens to be part
 * of the shield's own placeholder (`CUSTOM` in `PLATZHALTER-CUSTOM-1`, `TOM`
 * in the same) is no leak: the placeholder is fixed text that says nothing
 * about the user's message.
 */
export function findResidualRealValues(
  maskedText: string,
  map: PseudonymMap,
): IdentityLeak[] {
  const ranges = protectedRanges(maskedText, map);
  const leaks: IdentityLeak[] = [];
  for (const real of new Set(map.forward.keys())) {
    if (real.length === 0) continue;
    for (let at = maskedText.indexOf(real); at !== -1; at = maskedText.indexOf(real, at + 1)) {
      if (!insideAny(at, at + real.length, ranges)) {
        leaks.push({ path: '$', value: real });
        break;
      }
    }
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// Tolerant restore.
// ---------------------------------------------------------------------------

interface SurrogateForm {
  /** How the surrogate may appear in a model's text. */
  readonly form: string;
  /** What to restore it to; `undefined` when no real counterpart exists. */
  readonly real: string | undefined;
}

/** A first or last name of a person surrogate (#1545). Matched only in the
 *  spellings listed — as minted or all upper — never case-insensitively. */
interface PartForm {
  readonly spellings: ReadonlySet<string>;
  readonly real: string | undefined;
}

interface Forms {
  /** Exact surrogates and the forms derived from e-mail surrogates; matched
   *  case-insensitively. */
  readonly loose: readonly SurrogateForm[];
  /** Person-surrogate parts, keyed by their upper-case spelling. */
  readonly parts: ReadonlyMap<string, PartForm>;
}

/** Shortest e-mail local part treated as a form of its own. Pool locals are
 *  `first.last` (at least `ben.haas`), so this only keeps out degenerate
 *  cases. */
const MIN_LOCAL_PART_LENGTH = 5;

function sameReal(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** First and last token of a real person name; `undefined` parts for a name
 *  of a single token ("Jonas"), which has no first/last split to map to. */
function realNameParts(real: string): { readonly first?: string; readonly last?: string } {
  const tokens = real.trim().split(/\s+/u);
  return tokens.length < 2 ? {} : { first: tokens[0]!, last: tokens[tokens.length - 1]! };
}

/**
 * Every form of every surrogate in `map`, exact surrogates first, one entry
 * per lower-cased form. Surrogates that differ only in case belong to values
 * that differ only in case (`createPromptPseudonymMap` guarantees it), so a
 * case-insensitive hit may restore to either in the case the model wrote.
 * A DERIVED form two surrogates produce is ambiguous: it maps to no real
 * value and counts as unresolved.
 *
 * #1545 — a person surrogate also yields its first and last name, mapped to
 * the first and last token of the real name. Parts are not case-folded: the
 * pools hold no ordinary words, but "lukas" in lower case is still no name,
 * and minting keeps every part out of the user's own words. A part two people
 * share with different real names is ambiguous (unresolved), like a derived
 * form; a part that equals a loose form is left to the loose form.
 */
function surrogateForms(map: PseudonymMap): Forms {
  const forms = new Map<string, SurrogateForm>();
  for (const [surrogate, real] of map.reverse) {
    const key = surrogate.toLowerCase();
    if (surrogate.length > 0 && !forms.has(key)) forms.set(key, { form: surrogate, real });
  }
  const derived = new Map<string, SurrogateForm>();
  const addDerived = (form: string, real: string | undefined): void => {
    const key = form.toLowerCase();
    if (form.length === 0 || forms.has(key)) return;
    const prior = derived.get(key);
    if (prior === undefined) derived.set(key, { form, real });
    else if (!sameReal(prior.real, real)) derived.set(key, { form, real: undefined });
  };
  for (const [surrogate, real] of map.reverse) {
    const at = surrogate.indexOf('@');
    if (at <= 0 || !isReservedSurrogateShape(surrogate)) continue;
    const local = surrogate.slice(0, at);
    if (local.length < MIN_LOCAL_PART_LENGTH) continue;
    const realAt = real.indexOf('@');
    const realLocal = realAt > 0 ? real.slice(0, realAt) : undefined;
    addDerived(local, realLocal);
    const name = nameFromLocalPart(local);
    if (name !== undefined) {
      addDerived(name, realLocal === undefined ? undefined : nameFromLocalPart(realLocal));
    }
  }
  const loose = [...forms.values(), ...derived.values()];
  const looseKeys = new Set(loose.map((f) => f.form.toLowerCase()));

  const parts = new Map<string, PartForm>();
  const addPart = (form: string, real: string | undefined): void => {
    if (looseKeys.has(form.toLowerCase())) return;
    const key = form.toUpperCase();
    const prior = parts.get(key);
    const spellings = new Set([...(prior?.spellings ?? []), form, key]);
    const ambiguous = prior !== undefined && !sameReal(prior.real, real);
    parts.set(key, { spellings, real: ambiguous ? undefined : real });
  };
  for (const [surrogate, real] of map.reverse) {
    const minted = personSurrogateParts(surrogate);
    if (minted === undefined) continue;
    const of = realNameParts(real);
    addPart(minted.first, of.first);
    addPart(minted.last, of.last);
  }
  return { loose, parts };
}

function alternation(forms: Iterable<string>): string {
  return [...forms]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
}

/** One rewrite restore may apply: `[start, end)` becomes `text`. */
interface Claim {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** A surrogate form restore has no real value for (kept as written). */
  readonly unresolved: boolean;
  /** Tie-break among claims of one range: lower wins. */
  readonly rank: number;
}

function looseClaims(text: string, map: PseudonymMap, loose: readonly SurrogateForm[]): Claim[] {
  if (loose.length === 0) return [];
  const byKey = new Map(loose.map((f) => [f.form.toLowerCase(), f]));
  return [...text.matchAll(new RegExp(alternation(loose.map((f) => f.form)), 'giu'))].flatMap(
    (match): Claim[] => {
      const start = match.index;
      const end = start + match[0].length;
      const keep = { start, end, text: match[0], unresolved: false, rank: 0 };
      const exact = map.reverse.get(match[0]);
      if (exact !== undefined) return [{ ...keep, text: exact }];
      const form = byKey.get(match[0].toLowerCase());
      // A variant glued into a longer word is no surrogate: kept as written,
      // and its range is not handed to a shorter form either.
      if (form === undefined || !onWordBoundaries(text, start, end)) return [keep];
      if (form.real === undefined) return [{ ...keep, unresolved: true }];
      return [{ ...keep, text: caseLike(match[0], form.real) }];
    },
  );
}

function partClaims(text: string, parts: ReadonlyMap<string, PartForm>): Claim[] {
  if (parts.size === 0) return [];
  const spellings = [...parts.values()].flatMap((p) => [...p.spellings]);
  return [...text.matchAll(new RegExp(alternation(spellings), 'gu'))].flatMap((match): Claim[] => {
    const start = match.index;
    const end = start + match[0].length;
    const part = parts.get(match[0].toUpperCase());
    if (part === undefined || !part.spellings.has(match[0])) return [];
    if (!onWordBoundaries(text, start, end)) return [];
    if (part.real === undefined) return [{ start, end, text: match[0], unresolved: true, rank: 2 }];
    return [{ start, end, text: caseLike(match[0], part.real), unresolved: false, rank: 2 }];
  });
}

/**
 * #1577 — a date or amount literal the model re-spelled ("10.000 €" for
 * `€10000`, "1. Januar 2015" for `01.01.2015`) is restored when the values it
 * can denote name exactly ONE date/amount surrogate of the same kind:
 * minting keeps every such surrogate's value apart from every real value and
 * every other surrogate, so the reading is unambiguous. A literal that names
 * none, or more than one, stays as written (and is counted as unresolved by
 * `countUnresolvedSurrogates`).
 */
function valueClaims(text: string, map: PseudonymMap): Claim[] {
  const surrogates = [...map.reverse.keys()].flatMap((surrogate) => {
    const literal = asValueLiteral(surrogate);
    return literal === undefined || literal.values.length === 0 ? [] : [{ surrogate, literal }];
  });
  if (surrogates.length === 0) return [];
  return findValueLiterals(text).flatMap((literal): Claim[] => {
    if (literal.values.length === 0) return [];
    const named = surrogates.filter(
      (s) => s.literal.kind === literal.kind && s.literal.values.some((v) => literal.values.includes(v)),
    );
    const real = named.length === 1 ? map.reverse.get(named[0]!.surrogate) : undefined;
    if (real === undefined) return [];
    return [{ start: literal.start, end: literal.end, text: real, unresolved: false, rank: 1 }];
  });
}

/**
 * Every rewrite restore applies to `text`, non-overlapping, in text order:
 * the earliest claim wins, then the longest, then the surrogate form over a
 * value reading over a name part. One pass, so a restored value is never
 * itself rewritten and two readings of one span never both apply.
 */
function restoreClaims(text: string, map: PseudonymMap): Claim[] {
  const { loose, parts } = surrogateForms(map);
  const all = [...looseClaims(text, map, loose), ...valueClaims(text, map), ...partClaims(text, parts)].sort(
    (a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank,
  );
  const chosen: Claim[] = [];
  for (const claim of all) {
    const last = chosen[chosen.length - 1];
    if (last === undefined || claim.start >= last.end) chosen.push(claim);
  }
  return chosen;
}

/**
 * Restore prompt surrogates to real values, tolerating how a model rewrites
 * them (#1528): the exact surrogate as before, the surrogate in any letter
 * case, the local part of an e-mail surrogate and the name read out of it, a
 * first or last name of a person surrogate on its own (#1545: "Hallo Lukas",
 * "Herr Becker"), and a date or amount surrogate in another spelling (#1577).
 * A variant is restored in the case the model wrote it. Forms without a real
 * counterpart stay as written — `countUnresolvedForms` reports them.
 */
export function resolvePromptPseudonyms(text: string, map: PseudonymMap): string {
  if (map.reverse.size === 0 || text.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const claim of restoreClaims(text, map)) {
    out += text.slice(cursor, claim.start) + claim.text;
    cursor = claim.end;
  }
  return out + text.slice(cursor);
}

/**
 * How many distinct surrogate forms in `text` restore could not map back:
 * the name read out of an e-mail surrogate whose real address has no name in
 * it ("Lukas Becker" for `jw1984@…`), and a person-surrogate part that names
 * no single real name part (#1545: two people sharing "Lukas", or a real
 * name of one token). Word-bounded.
 */
export function countUnresolvedForms(text: string, map: PseudonymMap | undefined): number {
  if (map === undefined || map.reverse.size === 0 || text.length === 0) return 0;
  const hits = new Set(
    restoreClaims(text, map)
      .filter((claim) => claim.unresolved)
      .map((claim) => claim.text.toLowerCase()),
  );
  return hits.size;
}
