/**
 * Dates and amounts read as VALUES, whatever their spelling.
 *
 * A prompt placeholder for a date or an amount is itself a realistic literal
 * ("01.01.1970", "€10000" — `v4/pseudonym.ts`). Restore replaces exact
 * strings, so a model that writes one back in another spelling
 * ("1970-01-01", "1. Januar 1970", "10 Tsd. €") leaves a fake value restore
 * cannot map back. `countUnresolvedSurrogates` therefore compares dates and
 * amounts by value, through this module.
 *
 * Reading is generous on purpose — a hit only ever refuses an answer:
 *   - a literal yields every value it can denote: "01/05/1978" is the 1st of
 *     May or the 5th of January, "10.000 €" ten thousand or ten;
 *   - a literal that names no value — a date shape with a four-digit year
 *     19xx/20xx but no calendar day ("31.02.1990"), an amount whose grouping
 *     admits no reading ("1.000.00 €") — is still a literal, with no value:
 *     the caller reads it as "could be any value of its kind" (fail closed).
 *
 * Shapes: everything the C0 date and amount detectors mask (`promptMask.ts`)
 * plus the spellings a model rewrites them into — ISO and slashed dates,
 * unpadded and two-digit-year dates, written months (full and abbreviated,
 * the six shipped locales) day- or month-first, ordinal suffixes, thousands
 * grouped by ".", ",", spaces or apostrophes, and the scale words "k",
 * "Tsd.", "Tausend", "T€", "Mio.". Spelled-out numbers and dates without a
 * year are not read.
 */

export type ValueKind = 'date' | 'amount';

export interface ValueLiteral {
  readonly kind: ValueKind;
  /** Offsets of the literal in the text it was found in. */
  readonly start: number;
  readonly end: number;
  /**
   * Every value the literal can denote: `yyyy-mm-dd` for a date, a plain
   * decimal ("10000", "1234.56") for an amount. Empty for a literal that
   * names no value (see the module comment).
   */
  readonly values: readonly string[];
}

type Groups = Readonly<Record<string, string | undefined>>;

interface Shape {
  readonly kind: ValueKind;
  readonly re: RegExp;
  /** The values a match denotes; `undefined` when it is no literal at all. */
  readonly read: (groups: Groups) => readonly string[] | undefined;
}

/** Every date and amount literal in `text`, in shape order. */
export function findValueLiterals(text: string): ValueLiteral[] {
  return SHAPES.flatMap(({ kind, re, read }) =>
    [...text.matchAll(re)].flatMap((match): ValueLiteral[] => {
      const values = read(match.groups ?? {});
      if (values === undefined || match.index === undefined) return [];
      return [{ kind, start: match.index, end: match.index + match[0].length, values }];
    }),
  );
}

/**
 * The literal `text` consists of — one date or one amount and nothing else
 * (surrounding whitespace aside) — or `undefined`. Shapes that read the whole
 * text alike are merged; an unreadable reading wins (fail closed).
 */
export function asValueLiteral(text: string): ValueLiteral | undefined {
  const trimmed = text.trim();
  const whole = findValueLiterals(trimmed).filter(
    (literal) => literal.start === 0 && literal.end === trimmed.length,
  );
  const [first] = whole;
  if (first === undefined || whole.some((literal) => literal.kind !== first.kind)) {
    return undefined;
  }
  const unreadable = whole.some((literal) => literal.values.length === 0);
  return {
    ...first,
    values: unreadable ? [] : [...new Set(whole.flatMap((literal) => literal.values))],
  };
}

// --- dates -----------------------------------------------------------------

/** Month names (full and abbreviated) of the six shipped locales — a
 *  superset of the names the C0 date detector masks. Letters only, so the
 *  alternation below needs no escaping. */
const MONTH_NAMES: readonly (readonly string[])[] = [
  ['januar', 'january', 'janvier', 'enero', 'gennaio', 'januari', 'jänner', 'jan', 'jän', 'janv', 'ene', 'gen'],
  ['februar', 'february', 'février', 'febrero', 'febbraio', 'februari', 'feb', 'febr', 'févr', 'fév'],
  ['märz', 'march', 'mars', 'marzo', 'maart', 'mär', 'mrz', 'mar', 'mrt'],
  ['april', 'avril', 'abril', 'aprile', 'apr', 'avr', 'abr'],
  ['mai', 'may', 'mayo', 'maggio', 'mei', 'mag'],
  ['juni', 'june', 'juin', 'junio', 'giugno', 'jun', 'giu'],
  ['juli', 'july', 'juillet', 'julio', 'luglio', 'jul', 'juil', 'lug'],
  ['august', 'août', 'agosto', 'augustus', 'aug', 'ago'],
  ['september', 'septembre', 'septiembre', 'settembre', 'sep', 'sept', 'set'],
  ['oktober', 'october', 'octobre', 'octubre', 'ottobre', 'okt', 'oct', 'ott'],
  ['november', 'novembre', 'noviembre', 'nov'],
  ['dezember', 'december', 'décembre', 'diciembre', 'dicembre', 'dez', 'dec', 'déc', 'dic'],
];

const MONTH_BY_NAME: ReadonlyMap<string, number> = new Map(
  MONTH_NAMES.flatMap((names, index) => names.map((name) => [name, index + 1] as const)),
);

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** At most one horizontal space — never a line break: a list is no date. */
const SP = '[ \\u00a0\\u202f]?';
const SEP = `${SP}[./-]${SP}`;
/** Not glued to a number before it ("1.2.3.2020" holds no "2.3.2020"). */
const START = String.raw`(?<!\p{N}[./-]?)`;
/** Not continued by a number after it. */
const END = String.raw`(?![./-]?\p{N})`;
const MONTH = String.raw`(?<month>${[...MONTH_BY_NAME.keys()]
  .sort((a, b) => b.length - a.length)
  .join('|')})\.?(?!\p{L})`;

const DATE_SHAPES: readonly Shape[] = [
  {
    // 24.12.1987, 12/24/1987, 1.1.1970, 1. 1. 1970, 1.1.70 — either order.
    kind: 'date',
    re: new RegExp(
      `${START}(?<a>\\d{1,2})${SEP}(?<b>\\d{1,2})${SEP}(?<year>\\d{4}|\\d{2})${END}`,
      'gu',
    ),
    read: ({ a, b, year }) => readDate(year, [[b, a], [a, b]]),
  },
  {
    // 1987-12-24 (also with a time attached), 1987/12/24, 1987.12.24.
    kind: 'date',
    re: new RegExp(`${START}(?<year>\\d{4})${SEP}(?<m>\\d{1,2})${SEP}(?<d>\\d{1,2})${END}`, 'gu'),
    read: ({ year, m, d }) => readDate(year, [[m, d]]),
  },
  {
    // 24. Dezember 1987, 1er janvier 1970, 1 de enero de 1970, 1st of May, 1970.
    kind: 'date',
    re: new RegExp(
      `${START}(?<d>\\d{1,2})(?:\\.|er|e|st|nd|rd|th|º|°|ª)?${SP}(?:(?:de|of) )?${MONTH},?${SP}(?:(?:de|del) )?(?<year>\\d{4})${END}`,
      'giu',
    ),
    read: ({ d, month, year }) => readDate(year, [[monthNumber(month), d]]),
  },
  {
    // December 24, 1987 / Dec. 24th 1987.
    kind: 'date',
    re: new RegExp(
      `(?<!\\p{L})${MONTH}${SP}(?<d>\\d{1,2})(?:st|nd|rd|th|\\.)?(?![\\p{L}\\p{N}]),?${SP}(?<year>\\d{4})${END}`,
      'giu',
    ),
    read: ({ month, d, year }) => readDate(year, [[monthNumber(month), d]]),
  },
];

function monthNumber(name: string | undefined): string | undefined {
  const month = name === undefined ? undefined : MONTH_BY_NAME.get(name.toLowerCase());
  return month === undefined ? undefined : String(month);
}

/**
 * `yyyy-mm-dd` for every (month, day) order that names a calendar day; a
 * two-digit year stands for both centuries. No calendar day: `[]` for a
 * four-digit year the C0 detector would mask, else `undefined` (no date).
 */
function readDate(
  year: string | undefined,
  orders: readonly (readonly [string | undefined, string | undefined])[],
): readonly string[] | undefined {
  if (year === undefined) return undefined;
  const years = year.length === 2 ? [1900 + Number(year), 2000 + Number(year)] : [Number(year)];
  const days = years.flatMap((y) =>
    orders.flatMap(([m, d]) => calendarDay(y, Number(m), Number(d)) ?? []),
  );
  if (days.length > 0) return [...new Set(days)];
  return /^(?:19|20)\d{2}$/.test(year) ? [] : undefined;
}

function calendarDay(year: number, month: number, day: number): string | undefined {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  if (length === undefined || !Number.isInteger(day) || day < 1 || day > length) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// --- amounts ---------------------------------------------------------------

const CURRENCY_BEFORE = String.raw`(?:[€$£]|(?<![\p{L}\p{N}])(?:eur|usd|gbp|chf)(?!\p{L}))`;
const CURRENCY_AFTER = String.raw`(?:[€$£]|(?:eur|euro|euros|usd|dollar|dollars|gbp|chf|franken)(?!\p{L}))`;
/** Thousands grouped by ".", ",", spaces or apostrophes with an optional
 *  decimal part, or a plain digit run with one; never cut out of a longer
 *  number. A trailing ",-" / ".--" (no cents) is allowed. */
const NUMBER = String.raw`(?<num>\d{1,3}(?:[ \u00a0\u202f.,'\u2019]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![.,]?\d)(?:[.,]-{1,2})?`;
const SCALE = String.raw`(?<scale>k|tsd|tausend|thousand|mio|millionen|million|millions)(?!\p{L})\.?`;

const SCALE_FACTOR: Readonly<Record<string, bigint>> = {
  k: 1000n,
  t: 1000n,
  tsd: 1000n,
  tausend: 1000n,
  thousand: 1000n,
  mio: 1_000_000n,
  millionen: 1_000_000n,
  million: 1_000_000n,
  millions: 1_000_000n,
};

const AMOUNT_SHAPES: readonly Shape[] = [
  {
    // €10000, EUR 10.000,00, € 10k, CHF 10'000.
    kind: 'amount',
    re: new RegExp(`${CURRENCY_BEFORE}${SP}${NUMBER}(?:${SP}${SCALE})?`, 'giu'),
    read: ({ num, scale }) => readAmount(num, scale),
  },
  {
    // 10.000 €, 10.000,- €, 10k €, 10 Tsd. Euro, 10 T€, 10 TEUR.
    kind: 'amount',
    re: new RegExp(
      `(?<!\\p{N}[.,]?)${NUMBER}${SP}(?:${SCALE}${SP})?(?<glued>[kt])?${CURRENCY_AFTER}`,
      'giu',
    ),
    read: ({ num, scale, glued }) => readAmount(num, scale ?? glued),
  },
];

/** Every value `num` (scaled) can denote, as a plain decimal. */
function readAmount(num: string | undefined, scale: string | undefined): readonly string[] | undefined {
  if (num === undefined) return undefined;
  const factor = scale === undefined ? 1n : (SCALE_FACTOR[scale.toLowerCase()] ?? 1n);
  return thousandthsOf(num).map((value) => plainDecimal(value * factor));
}

/**
 * Every value of a grouped number, in thousandths: the last "." or "," is
 * a decimal point (unless the same mark already groups the head, as in
 * "1.000.000") and, when exactly three digits follow it, a thousands
 * separator too ("10.000" = ten thousand or ten).
 */
function thousandthsOf(num: string): bigint[] {
  const compact = num.replace(/[ \u00a0\u202f'\u2019]/gu, '');
  const last = Math.max(compact.lastIndexOf('.'), compact.lastIndexOf(','));
  if (last < 0) return [BigInt(compact) * 1000n];
  const head = compact.slice(0, last);
  const tail = compact.slice(last + 1);
  const headDigits = head.replace(/[.,]/g, '');
  const asGrouping = tail.length === 3 ? [BigInt(headDigits + tail) * 1000n] : [];
  const asDecimal = head.includes(compact.charAt(last))
    ? []
    : [BigInt(headDigits) * 1000n + BigInt(tail.padEnd(3, '0'))];
  return [...asGrouping, ...asDecimal];
}

/** 10000500n thousandths → "10000.5". */
function plainDecimal(thousandths: bigint): string {
  const units = (thousandths / 1000n).toString();
  const fraction = (thousandths % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction === '' ? units : `${units}.${fraction}`;
}

const SHAPES: readonly Shape[] = [...DATE_SHAPES, ...AMOUNT_SHAPES];
