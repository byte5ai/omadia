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
 *     Becker"). The exact form is still the first choice; variants only match
 *     on word boundaries.
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

import { caseLike, FIRST_NAMES, LAST_NAMES } from './v4/pseudonym.js';
import type { IdentityLeak } from './v4/onTheWire.js';
import type { PseudonymMap } from './v4/types.js';

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

/** Shortest e-mail local part treated as a form of its own. Pool locals are
 *  `first.last` (at least `ben.wolf`), so this only keeps out degenerate
 *  cases. */
const MIN_LOCAL_PART_LENGTH = 5;

const NAME_LIKE_LOCAL = /^(\p{L}+)[._](\p{L}+)$/u;

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

/** "jonas.weber" → "Jonas Weber"; undefined when the local part is no name. */
function nameFromLocalPart(local: string): string | undefined {
  const m = NAME_LIKE_LOCAL.exec(local);
  return m === null ? undefined : `${capitalize(m[1]!)} ${capitalize(m[2]!)}`;
}

/**
 * Every form of every surrogate in `map`, exact surrogates first, one entry
 * per lower-cased form. Surrogates that differ only in case belong to values
 * that differ only in case (`createPromptPseudonymMap` guarantees it), so a
 * case-insensitive hit may restore to either in the case the model wrote.
 * A DERIVED form two surrogates produce is ambiguous: it maps to no real
 * value and counts as unresolved.
 */
function surrogateForms(map: PseudonymMap): SurrogateForm[] {
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
    else if (prior.real?.toLowerCase() !== real?.toLowerCase()) derived.set(key, { form, real: undefined });
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
  return [...forms.values(), ...derived.values()];
}

function formsPattern(forms: readonly SurrogateForm[]): RegExp {
  const alternation = [...forms]
    .sort((a, b) => b.form.length - a.form.length)
    .map((f) => escapeRegExp(f.form))
    .join('|');
  return new RegExp(alternation, 'giu');
}

/**
 * Restore prompt surrogates to real values, tolerating how a model rewrites
 * them (#1528): the exact surrogate as before, the surrogate in any letter
 * case, the local part of an e-mail surrogate and the name read out of it. A
 * variant is restored in the case the model wrote it. One pass over the text,
 * so a restored value is never itself rewritten. Forms without a real
 * counterpart stay as written — `countUnresolvedForms` reports them.
 */
export function resolvePromptPseudonyms(text: string, map: PseudonymMap): string {
  if (map.reverse.size === 0 || text.length === 0) return text;
  const forms = surrogateForms(map);
  const byKey = new Map(forms.map((f) => [f.form.toLowerCase(), f]));
  return text.replace(formsPattern(forms), (match: string, offset: number) => {
    const exact = map.reverse.get(match);
    if (exact !== undefined) return exact;
    const form = byKey.get(match.toLowerCase());
    if (form === undefined || form.real === undefined) return match;
    if (!onWordBoundaries(text, offset, offset + match.length)) return match;
    return caseLike(match, form.real);
  });
}

/**
 * How many distinct surrogate forms in `text` restore could not map back:
 * today the name read out of an e-mail surrogate whose real address has no
 * name in it ("Lukas Becker" for `jw1984@…`). Word-bounded, case-insensitive.
 */
export function countUnresolvedForms(text: string, map: PseudonymMap | undefined): number {
  if (map === undefined || map.reverse.size === 0 || text.length === 0) return 0;
  const unresolved = surrogateForms(map).filter((f) => f.real === undefined);
  if (unresolved.length === 0) return 0;
  const hits = new Set<string>();
  for (const match of text.matchAll(formsPattern(unresolved))) {
    if (match.index === undefined) continue;
    if (onWordBoundaries(text, match.index, match.index + match[0].length)) {
      hits.add(match[0].toLowerCase());
    }
  }
  return hits.size;
}
