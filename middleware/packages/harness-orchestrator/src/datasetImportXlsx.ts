/**
 * XLSX → tabular parse (companion to `datasetImport.ts`'s `parseCsv`).
 *
 * Produces the SAME `TableParseResult` shape the CSV parser produces, so an
 * uploaded spreadsheet flows through the identical downstream pipeline:
 * type inference → mandatory per-row privacy scan → `ingestDataset`. Nothing
 * here re-implements that pipeline; this module's only job is
 * `bytes -> header-keyed string rows`.
 *
 * ## Why every cell is normalized to a STRING
 *
 * ExcelJS hands back real JS types (`number`, `Date`, `boolean`) that the CSV
 * path can only infer from text. Adopting them directly looks like a free
 * upgrade — it is not. `buildDatasetFromTable` runs the C0 privacy scan on
 * `string`-typed columns ONLY (a `number`/`date` column has no free-text
 * surface by construction, see `datasetImport.ts`'s module doc). Trusting
 * Excel's declared types would therefore route more columns AROUND the scan
 * on the say-so of the uploaded file itself — a spreadsheet whose column is
 * formatted as "Text" vs "Number" would get different privacy treatment for
 * identical content. Normalizing to strings and re-running the same
 * inference the CSV path uses keeps one privacy decision procedure for both
 * formats, and keeps the file's own formatting out of that decision.
 *
 * ## Zip-bomb posture
 *
 * An .xlsx is a ZIP archive; ExcelJS inflates it fully in memory and has no
 * decompression budget of its own. `MAX_XLSX_BYTES` caps the compressed
 * upload before `load()` is called, and `MAX_SHEETS` plus the shared
 * `MAX_DATASET_ROWS` cap bound what a well-formed-but-huge workbook can
 * allocate afterwards. These are refusals, not truncations: a workbook over
 * budget yields `{ ok: false, reason }` rather than a silently partial
 * import, because a partial spreadsheet is indistinguishable from a complete
 * one once it reaches the model.
 */

import ExcelJS from 'exceljs';

import {
  MAX_CELL_CHARS,
  MAX_DATASET_ROWS,
  type TableParse,
  type TableParseResult,
} from './datasetImport.js';

/** Compressed-upload cap, enforced BEFORE the archive is inflated. */
export const MAX_XLSX_BYTES = 25 * 1024 * 1024;

/** Per-workbook sheet cap — each sheet becomes its own dataset. */
export const MAX_SHEETS = 20;

/**
 * One ExcelJS cell value → plain string. Handles every shape the library
 * documents: primitives, dates, formula results, rich text, hyperlinks and
 * error cells.
 *
 * Formula cells yield their CACHED RESULT, never the formula source — a
 * stored `=SUM(B2:B23)` would otherwise be imported as that literal text,
 * making the column `string`-typed and the data meaningless. A formula whose
 * result Excel never cached (file written by a generator that skipped
 * calculation) has no value to import and becomes ''.
 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    // ISO date-only when the time component is exactly midnight UTC (Excel's
    // representation of a pure date), full ISO otherwise. Both forms are
    // matched by `datasetImport.ts`'s DATE_RE, so the shared inference types
    // the column as 'date' exactly as it would for the CSV equivalent.
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? (iso.split('T')[0] ?? iso) : iso;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // Formula / shared-formula cell: use the cached result, recursively (a
    // result can itself be a Date or an error object).
    if ('result' in v) return cellToString(v['result']);
    // Error cell (#DIV/0!, #N/A, …): keep the marker so the column falls back
    // to 'string' and a human can see the source file was broken.
    if ('error' in v) return String(v['error']);
    // Rich text: concatenate the runs, dropping formatting.
    if ('richText' in v && Array.isArray(v['richText'])) {
      return (v['richText'] as Array<{ text?: unknown }>)
        .map((r) => (typeof r.text === 'string' ? r.text : ''))
        .join('');
    }
    // Hyperlink cell: the visible text, not the target URL.
    if ('text' in v) return cellToString(v['text']);
    // A formula with no cached result and no other recognized field.
    if ('formula' in v || 'sharedFormula' in v) return '';
  }
  return String(value);
}

/** Trim + collapse internal whitespace in a header cell. */
function normalizeHeader(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Make header names unique and non-empty, preserving order. An unnamed
 * column becomes `column_<n>` (1-based sheet position); a duplicate gets a
 * `_2`, `_3`, … suffix. Downstream code keys rows by header name, so a
 * collision would silently drop a column's data.
 */
function uniqueHeaders(rawHeaders: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return rawHeaders.map((raw, idx) => {
    const base = normalizeHeader(raw) || `column_${String(idx + 1)}`;
    const prior = seen.get(base);
    if (prior === undefined) {
      seen.set(base, 1);
      return base;
    }
    const next = prior + 1;
    seen.set(base, next);
    return `${base}_${String(next)}`;
  });
}

/** Cell strings for one worksheet row, indexed 0-based by column. */
function rowValues(row: ExcelJS.Row, columnCount: number): string[] {
  const out: string[] = [];
  for (let c = 1; c <= columnCount; c += 1) {
    out.push(cellToString(row.getCell(c).value));
  }
  return out;
}

function nonEmptyCount(values: readonly string[]): number {
  return values.filter((v) => v.trim().length > 0).length;
}

/**
 * Locate the header row. Spreadsheets routinely open with a decorative title
 * or a blank spacer before the real table — a single merged cell reading
 * "Mitarbeiterübersicht Q3" would otherwise become the header and every real
 * header would be imported as data.
 *
 * Rule: the first row carrying at least TWO non-empty cells is the header.
 * A one-cell row cannot be a multi-column table's header, and a title row is
 * one cell by construction. Single-column sheets have no such ambiguity, so
 * they fall back to the first row with any content at all.
 *
 * Returns the 1-based worksheet row number, or `undefined` for an empty sheet.
 */
function findHeaderRow(
  worksheet: ExcelJS.Worksheet,
  columnCount: number,
): number | undefined {
  let firstNonEmpty: number | undefined;
  let found: number | undefined;
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (found !== undefined) return;
    const count = nonEmptyCount(rowValues(row, columnCount));
    if (count === 0) return;
    if (firstNonEmpty === undefined) firstNonEmpty = rowNumber;
    if (count >= 2) found = rowNumber;
  });
  if (found !== undefined) return found;
  // Single-column sheet (or a sheet whose every row has one value).
  return firstNonEmpty;
}

/** One parsed worksheet plus the sheet name, so each becomes its own dataset. */
export interface XlsxSheetParse extends TableParse {
  /** Worksheet name as written in the workbook. */
  sheetName: string;
}

export type XlsxParseResult =
  | { ok: true; sheets: XlsxSheetParse[] }
  | { ok: false; reason: string };

/**
 * Parse XLSX bytes into one `TableParse` per non-empty worksheet. Never
 * throws — a corrupt archive, a password-protected workbook or an
 * over-budget upload all resolve to `{ ok: false, reason }`.
 *
 * Sheets with no usable table (empty, or a header row but zero data rows)
 * are skipped rather than failing the whole workbook; a summary sheet next
 * to a data sheet is normal. A workbook where NO sheet yields rows is an
 * error, so the caller never ingests nothing and reports success.
 */
export async function parseXlsx(bytes: Buffer): Promise<XlsxParseResult> {
  if (bytes.length > MAX_XLSX_BYTES) {
    return {
      ok: false,
      reason: `XLSX is ${String(bytes.length)} bytes, exceeding the ${String(MAX_XLSX_BYTES)}-byte upload cap`,
    };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS types `load` against the DOM `ArrayBuffer`; a Node Buffer is
    // accepted at runtime and is what every caller has.
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch (err) {
    return {
      ok: false,
      reason: `invalid or unreadable XLSX — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const worksheets = workbook.worksheets;
  if (worksheets.length === 0) {
    return { ok: false, reason: 'XLSX contains no worksheets' };
  }
  if (worksheets.length > MAX_SHEETS) {
    return {
      ok: false,
      reason: `XLSX has ${String(worksheets.length)} sheets, exceeding the ${String(MAX_SHEETS)}-sheet import cap`,
    };
  }

  const sheets: XlsxSheetParse[] = [];
  for (const worksheet of worksheets) {
    const parsed = parseWorksheet(worksheet);
    if (parsed === undefined) continue;
    if (!parsed.ok) return parsed;
    sheets.push(parsed.sheet);
  }

  if (sheets.length === 0) {
    return { ok: false, reason: 'XLSX has no worksheet with data rows' };
  }
  return { ok: true, sheets };
}

/**
 * Parse one worksheet. `undefined` = skip this sheet (nothing importable);
 * `{ ok: false }` = the whole workbook must fail (a cap was exceeded, which
 * must never degrade to a partial import).
 */
function parseWorksheet(
  worksheet: ExcelJS.Worksheet,
): { ok: true; sheet: XlsxSheetParse } | { ok: false; reason: string } | undefined {
  const columnCount = worksheet.columnCount;
  if (columnCount === 0 || worksheet.rowCount === 0) return undefined;

  const headerRowNumber = findHeaderRow(worksheet, columnCount);
  if (headerRowNumber === undefined) return undefined;

  const rawHeaders = rowValues(worksheet.getRow(headerRowNumber), columnCount);
  // Drop trailing all-empty columns: ExcelJS reports `columnCount` from the
  // widest styled row, so a sheet with formatting past the data would
  // otherwise gain phantom `column_N` headers.
  let lastMeaningful = -1;
  for (let i = 0; i < rawHeaders.length; i += 1) {
    if ((rawHeaders[i] ?? '').trim().length > 0) lastMeaningful = i;
  }
  if (lastMeaningful < 0) return undefined;
  const width = lastMeaningful + 1;
  const headers = uniqueHeaders(rawHeaders.slice(0, width));

  const rows: Array<Record<string, string>> = [];
  let truncatedCellCount = 0;
  const truncatedColumnSet = new Set<string>();
  let overflow = false;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    if (overflow) return;
    if (rows.length >= MAX_DATASET_ROWS) {
      overflow = true;
      return;
    }
    const values = rowValues(row, width);
    // Skip fully blank rows — spacer rows between blocks are common and
    // would otherwise import as all-null records.
    if (nonEmptyCount(values) === 0) return;
    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      const full = values[idx] ?? '';
      if (full.length > MAX_CELL_CHARS) {
        truncatedCellCount += 1;
        truncatedColumnSet.add(header);
      }
      record[header] = full.slice(0, MAX_CELL_CHARS);
    });
    rows.push(record);
  });

  if (overflow) {
    return {
      ok: false,
      reason: `sheet '${worksheet.name}' exceeds the ${String(MAX_DATASET_ROWS)}-row import cap`,
    };
  }
  if (rows.length === 0) return undefined;

  return {
    ok: true,
    sheet: {
      sheetName: worksheet.name,
      headers,
      rows,
      truncation: {
        truncatedCellCount,
        truncatedColumns: headers.filter((h) => truncatedColumnSet.has(h)),
      },
    },
  };
}

/** Convenience wrapper matching `parseCsv`'s single-table return, used where
 *  only one table is expected. Picks the first sheet that yielded rows. */
export async function parseXlsxFirstSheet(
  bytes: Buffer,
): Promise<TableParseResult> {
  const result = await parseXlsx(bytes);
  if (!result.ok) return result;
  const first = result.sheets[0];
  if (first === undefined) {
    return { ok: false, reason: 'XLSX has no worksheet with data rows' };
  }
  return { ok: true, headers: first.headers, rows: first.rows, truncation: first.truncation };
}
