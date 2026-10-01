import ExcelJS from 'exceljs';
import {
  DETERMINISTIC_EPOCH,
  MEDIA_TYPE,
  OfficeRenderError,
  isFormulaCell,
  type CellValue,
  type ColumnSpec,
  type ColumnType,
  type RenderResult,
  type XlsxDescriptor,
} from './types.js';
import { sanitizeFilename } from './filename.js';
import {
  assertComputedColumnStaysInWorkbook,
  assertFormulaStaysInWorkbook,
} from './formulaPolicy.js';
import { normalizeOoxml } from './ooxmlNormalize.js';
import {
  PROVENANCE_CATEGORY,
  PROVENANCE_DESCRIPTION,
  PROVENANCE_GENERATOR,
  PROVENANCE_KEYWORDS,
} from './provenance.js';

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  CHF: 'CHF',
  JPY: '¥',
};

// Excel forbids these in sheet names and caps the length at 31.
const ILLEGAL_SHEET_CHARS = /[\\/?*[\]:]+/g;

function sanitizeSheetName(name: string, index: number): string {
  const cleaned = name.replace(ILLEGAL_SHEET_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const safe = cleaned.length > 0 ? cleaned : `Sheet${String(index + 1)}`;
  return safe.slice(0, 31);
}

/** Derive an Excel number-format string from the column spec. Explicit
 *  `numFmt` always wins; otherwise the semantic `type` drives it. */
function numFmtFor(col: ColumnSpec): string | undefined {
  if (col.numFmt) return col.numFmt;
  switch (col.type) {
    case 'currency': {
      const symbol = CURRENCY_SYMBOLS[(col.currency ?? 'EUR').toUpperCase()] ?? col.currency ?? '€';
      return `#,##0.00 "${symbol}"`;
    }
    case 'number':
      return '#,##0.######';
    case 'percent':
      return '0.00%';
    case 'date':
      return 'yyyy-mm-dd';
    default:
      return undefined;
  }
}

/** What a cell may hold, for the error that refuses anything else. */
const CELL_VALUE_RULE =
  'a cell holds text, a number, true or false, null, or a formula cell { formula } whose formula is non-empty text, and nothing else';

/**
 * The value a row holds for a column key, as the renderer stores it, or
 * undefined when it is not one a cell may hold. Only the row's own keys count,
 * so a column named `constructor` reads nothing from the object's prototype.
 * A formula cell is rebuilt as `{ formula }` from a single read of `formula`,
 * so whatever else the object carries (a cached `result` above all) stays
 * behind.
 *
 * Anything else is refused rather than passed on, because exceljs decides what
 * a cell is from the shape of the value, not from our types: an object with a
 * truthy `formula` or `sharedFormula` becomes a formula, with any `result`
 * stored as its cached value, and `{ text, hyperlink }` becomes an external
 * link. The input schema refuses those shapes already; this is what holds for
 * a caller that skips it (`renderXlsx` is exported).
 */
function cellValueOf(row: Readonly<Record<string, unknown>>, key: string): CellValue | undefined {
  const value = Object.hasOwn(row, key) ? row[key] : undefined;
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const formula: unknown = (value as { formula?: unknown }).formula;
  return typeof formula === 'string' && formula.length > 0 ? { formula } : undefined;
}

/**
 * Check a column before exceljs sees it. The header has to be text: exceljs
 * writes it into row 1 like any cell value (an array into several rows), so a
 * header object would be read by its shape just like a refused cell value. A
 * computed column's template has to be text too, and passes the formula
 * policy once rather than per row: `{row}` only ever becomes digits, and the
 * check refuses a template in which those digits could extend a function name
 * or open a call. Both formula checks start with the formula's text
 * (formulaText.ts), so what they read is what exceljs writes and the opening
 * application reads.
 */
function checkColumn(col: ColumnSpec, sheetName: string): void {
  if (typeof col.header !== 'string') {
    throw new OfficeRenderError(
      `header in sheet "${sheetName}", column "${String(col.key)}" rejected: a column header is text`,
    );
  }
  if (!col.formula) return;
  const location = `sheet "${sheetName}", computed column "${String(col.key)}"`;
  if (typeof col.formula !== 'string') {
    throw new OfficeRenderError(`formula in ${location} rejected: a computed column's formula is text`);
  }
  assertComputedColumnStaysInWorkbook(col.formula, location);
}

/** Coerce a cell value into the type Excel should store, so number formats
 *  actually apply (a currency stored as text would not sum). Falls back to
 *  the original value when coercion is not possible — never throws. */
function coerce(value: CellValue, type: ColumnType | undefined): CellValue | Date {
  if (value === null) return null;
  if (type === 'date' && typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d;
  }
  if (
    (type === 'number' || type === 'currency' || type === 'percent') &&
    typeof value === 'string'
  ) {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  return value;
}

/** The formula a cell gets, or undefined for a plain value. A computed column
 *  writes its template with `{row}` → this row's number; an inline formula
 *  cell writes its own formula. */
function formulaFor(
  col: ColumnSpec,
  value: CellValue | Date | undefined,
  rowNumber: number,
): string | undefined {
  if (col.formula) return col.formula.replaceAll('{row}', String(rowNumber));
  return isFormulaCell(value) ? value.formula : undefined;
}

/**
 * Render an {@link XlsxDescriptor} to .xlsx bytes. Deterministic: the same
 * descriptor yields the same logical workbook (metadata timestamps are pinned
 * to a fixed epoch; no wall-clock leakage). Only `inline` sheet sources are
 * supported in this phase — a `dataset` source throws so the caller can
 * surface a clear "not yet wired" error rather than silently emit an empty
 * sheet.
 */
export async function renderXlsx(descriptor: XlsxDescriptor): Promise<RenderResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = PROVENANCE_GENERATOR;
  workbook.created = DETERMINISTIC_EPOCH;
  workbook.modified = DETERMINISTIC_EPOCH;
  // Static AI-Act Art. 50 provenance marking (#645). exceljs has no reliable
  // custom-property API, so .xlsx gets a coarser core-property marker than the
  // structured customProperties .docx carries — a documented limitation (see
  // the package README). All values are constant: no new nondeterminism.
  workbook.description = PROVENANCE_DESCRIPTION;
  workbook.keywords = PROVENANCE_KEYWORDS;
  workbook.category = PROVENANCE_CATEGORY;
  if (descriptor.title) workbook.title = descriptor.title;

  let rowsWritten = 0;
  let wroteFormula = false;

  descriptor.sheets.forEach((sheet, index) => {
    const ws = workbook.addWorksheet(sanitizeSheetName(sheet.name, index));
    // Headers and computed-column templates are checked before exceljs sees
    // any of them.
    for (const col of sheet.columns) checkColumn(col, ws.name);
    ws.columns = sheet.columns.map((col) => ({
      header: col.header,
      key: col.key,
      ...(col.width !== undefined ? { width: col.width } : {}),
      ...(numFmtFor(col) ? { style: { numFmt: numFmtFor(col) } } : {}),
    }));
    // Bold the header row.
    ws.getRow(1).font = { bold: true };

    for (const row of sheet.rows) {
      const coerced: Record<string, CellValue | Date> = {};
      for (const [columnIndex, col] of sheet.columns.entries()) {
        // Computed columns derive their value from the formula template below,
        // not from the row/dataset — leave the cell empty for now.
        if (col.formula) {
          coerced[col.key] = null;
          continue;
        }
        const value = cellValueOf(row, col.key);
        if (value === undefined) {
          // addRow has not run for this row yet, so it lands on the next one.
          const address = `${ws.getColumn(columnIndex + 1).letter}${String(ws.rowCount + 1)}`;
          throw new OfficeRenderError(
            `value in sheet "${ws.name}", cell ${address} rejected: ${CELL_VALUE_RULE}`,
          );
        }
        coerced[col.key] = coerce(value, col.type);
      }
      const added = ws.addRow(coerced);
      const rowNumber = added.number;
      // Write real Excel formulas explicitly, and nothing but the formula: no
      // cached value is ever stored next to one (defence in depth on top of
      // `cellValueOf`). Cross-sheet references (e.g. `'Offene Posten'!C:C`)
      // resolve when the opening application recalculates.
      for (const col of sheet.columns) {
        const formula = formulaFor(col, coerced[col.key], rowNumber);
        if (formula === undefined) continue;
        const cell = added.getCell(col.key);
        if (!col.formula) {
          assertFormulaStaysInWorkbook(formula, `sheet "${ws.name}", cell ${cell.address}`);
        }
        cell.value = { formula };
        wroteFormula = true;
      }
      rowsWritten += 1;
    }
  });

  // omadia evaluates no formulas and stores no cached values, so ask the
  // opening application for a full recalculation on load; exceljs 4.4 writes
  // `<calcPr calcId="171027" fullCalcOnLoad="1"/>`. The flag is a constant
  // (no new nondeterminism) and is set only when a formula exists: Excel marks
  // a recalculated workbook as changed, which a plain data export does not need.
  if (wroteFormula) workbook.calcProperties = { fullCalcOnLoad: true };

  const raw = Buffer.from((await workbook.xlsx.writeBuffer()) as unknown as Uint8Array);
  // exceljs pins the core-property timestamps to DETERMINISTIC_EPOCH but still
  // stamps each zip entry's mtime from the wall clock; normalize so re-renders
  // are byte-identical and the content-addressed cache hits (#645). Core dates
  // are already the epoch, so no core.xml rewrite is needed here.
  const buffer = await normalizeOoxml(raw);

  return {
    buffer,
    mediaType: MEDIA_TYPE.xlsx,
    ext: 'xlsx',
    filename: sanitizeFilename(descriptor.filename, 'xlsx', 'export'),
    rowsWritten,
  };
}
