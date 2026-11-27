/**
 * #1845 — date cells of an imported table, normalised to ISO-8601.
 *
 * A column is typed `date` only when every value is a real calendar date in
 * one reading. The value stored is ISO (`2024-04-19`, `2025-03-01T10:30:00Z`),
 * so the dataset verbs — which compare non-numbers as text — sort and filter
 * a `date` column in date order whatever format the file used. Before, a
 * `19.04.2024` column was typed `date` but stored as written, and "latest
 * date" compared the day first.
 *
 * Accepted shapes:
 *   - ISO date, optionally with a time (`T` or space), seconds, fractional
 *     seconds and `Z` or an offset — the form XLSX timestamps arrive in
 *     (`2025-03-01T10:30:00.000Z`). A zone is converted to UTC (`…Z`).
 *   - `d.m.yyyy` and `d/m/yyyy`, optionally followed by `hh:mm[:ss]`. A column
 *     whose slash dates only read as month-first (`04/19/2024`) is read
 *     `m/d/yyyy` throughout; a column mixing both readings is not a date.
 *     Two-digit years follow the POSIX `%y` pivot: 00–68 → 20xx, 69–99 → 19xx.
 */

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;
const DMY_RE = /^(\d{1,2})([./])(\d{1,2})\2(\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export type DateOrder = 'dmy' | 'mdy';

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isClockTime(h: number, m: number, s: number): boolean {
  return h <= 23 && m <= 59 && s <= 59;
}

function expandYear(raw: string): number {
  const year = Number(raw);
  if (raw.length === 4) return year;
  return year <= 68 ? 2000 + year : 1900 + year;
}

function isoDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function normaliseIso(m: RegExpExecArray): string | undefined {
  const [, y, mo, d, hh, mm, ss, frac, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (!isCalendarDate(year, month, day)) return undefined;
  if (hh === undefined || mm === undefined) return isoDate(year, month, day);
  const sec = ss === undefined ? 0 : Number(ss);
  if (!isClockTime(Number(hh), Number(mm), sec)) return undefined;
  if (zone === undefined) {
    return `${isoDate(year, month, day)}T${hh}:${mm}${ss === undefined ? '' : `:${ss}`}`;
  }
  const offset = /^z$/i.test(zone) ? 'Z' : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = new Date(`${isoDate(year, month, day)}T${hh}:${mm}:${pad(sec)}${frac ?? ''}${offset}`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  // Whole seconds unless the file carried a real fraction.
  const iso = parsed.toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

function normaliseDmy(m: RegExpExecArray, order: DateOrder): string | undefined {
  const [, a, , b, y, hh, mm, ss] = m;
  const year = expandYear(y ?? '');
  const day = Number(order === 'dmy' ? a : b);
  const month = Number(order === 'dmy' ? b : a);
  if (!isCalendarDate(year, month, day)) return undefined;
  const date = isoDate(year, month, day);
  if (hh === undefined || mm === undefined) return date;
  const sec = ss === undefined ? 0 : Number(ss);
  if (!isClockTime(Number(hh), Number(mm), sec)) return undefined;
  return `${date}T${pad(Number(hh))}:${mm}${ss === undefined ? '' : `:${ss}`}`;
}

/** One cell as an ISO date/datetime, or `undefined` when it is not a date in
 *  the given reading of day/month order. */
export function normaliseDateCell(value: string, order: DateOrder = 'dmy'): string | undefined {
  const trimmed = value.trim();
  const iso = ISO_RE.exec(trimmed);
  if (iso) return normaliseIso(iso);
  const dmy = DMY_RE.exec(trimmed);
  if (!dmy) return undefined;
  // A dotted date is always day-first; only a slash date can be month-first.
  if (order === 'mdy' && dmy[2] === '.') return undefined;
  return normaliseDmy(dmy, order);
}

/**
 * The reading in which EVERY non-empty value is a date, or `undefined` when
 * there is none (the column is then not a date column). Day-first wins when
 * both fit.
 */
export function dateOrderForColumn(nonEmpty: readonly string[]): DateOrder | undefined {
  if (nonEmpty.length === 0) return undefined;
  for (const order of ['dmy', 'mdy'] as const) {
    if (nonEmpty.every((v) => normaliseDateCell(v, order) !== undefined)) return order;
  }
  return undefined;
}

/**
 * #2302 (ADR-0267) — a date range bound from a `query_rows` filter in the
 * ISO form the cells are stored in, read with the import's parser: every
 * shape listed above, day-first unless only month-first fits
 * (`04/19/2024`). `undefined` when the value is not a date in either
 * reading.
 */
export function normaliseDateFilterValue(value: string): string | undefined {
  const order = dateOrderForColumn([value]);
  return order === undefined ? undefined : normaliseDateCell(value, order);
}

/** The bound shapes `normaliseDateFilterValue` reads — named in the tool
 *  error for a date range filter it could not parse. */
export const DATE_FILTER_FORMATS =
  'ISO `yyyy-mm-dd` or `yyyy-mm-ddThh:mm[:ss]` (optional `Z` or `±hh:mm`), `d.m.yyyy` or `d/m/yyyy` (day-first; `m/d/yyyy` only when the day is above 12), each optionally followed by `hh:mm[:ss]`';
