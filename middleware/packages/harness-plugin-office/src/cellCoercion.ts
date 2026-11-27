import type { CellValue, ColumnType } from './types.js';

/**
 * #1971 — strict typing of `create_xlsx` cell values.
 *
 * `new Date()` and `Number()` accept inputs they read wrong (`12.03.2024` as
 * 3 December, `März 2024` as 1 January, `""` as 0, `0x1F` as 31, `Infinity`),
 * and the file then holds a different value than the model passed. Only
 * unambiguous formats are converted; everything else stays as text and is
 * reported, so the model can tell the user.
 */

/** `YYYY-MM-DD`, optionally with a time and zone. A time without a zone is
 *  read as UTC, so the server's time zone never shifts the day. */
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** A plain decimal: optional sign, digits with `.` as decimal point, optional
 *  exponent. No thousands separators, no hex, no `Infinity`. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const NUMERIC_TYPES: ReadonlySet<ColumnType> = new Set(['number', 'currency', 'percent']);

/** The coerced cell, and whether a typed column's value had to stay text. */
export interface CoercedCell {
  readonly value: CellValue | Date;
  readonly keptAsText: boolean;
}

function parseIsoDate(text: string): Date | undefined {
  const m = ISO_DATE.exec(text);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  // The calendar date must exist (no 2024-02-30): build it in UTC and read it back.
  const dayStart = new Date(Date.UTC(year, month - 1, day));
  if (
    dayStart.getUTCFullYear() !== year ||
    dayStart.getUTCMonth() !== month - 1 ||
    dayStart.getUTCDate() !== day
  ) {
    return undefined;
  }
  if (h === undefined) return dayStart;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${zone ?? 'Z'}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseDecimal(text: string): number | undefined {
  if (!DECIMAL.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Coerce a cell into the type its column declares, so number formats apply.
 * An empty string, and `false` (Odoo's empty field) in a date or numeric
 * column, become an empty cell. Never throws.
 */
export function coerceCell(value: CellValue, type: ColumnType | undefined): CoercedCell {
  // A non-finite number has no valid representation in the sheet XML.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { value: String(value), keptAsText: true };
  }
  const typed = type === 'date' || (type !== undefined && NUMERIC_TYPES.has(type));
  if (!typed) return { value, keptAsText: false };
  if (value === null || value === false) return { value: null, keptAsText: false };
  if (typeof value !== 'string') return { value, keptAsText: false };
  const text = value.trim();
  if (text === '') return { value: null, keptAsText: false };
  const converted = type === 'date' ? parseIsoDate(text) : parseDecimal(text);
  return converted === undefined
    ? { value, keptAsText: true }
    : { value: converted, keptAsText: false };
}

/**
 * #1969 — a formula's text without the one leading `=` a model types by
 * habit. The file format stores a formula without it; written as is, the
 * application reads `==SUM(…)`.
 */
export function withoutLeadingEquals(formula: string): string {
  return formula.startsWith('=') ? formula.slice(1) : formula;
}
