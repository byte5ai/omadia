import ExcelJS from 'exceljs';
import {
  DETERMINISTIC_EPOCH,
  MEDIA_TYPE,
  isFormulaCell,
  type CellValue,
  type ColumnSpec,
  type ColumnType,
  type RenderResult,
  type XlsxDescriptor,
} from './types.js';
import { sanitizeFilename } from './filename.js';
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

/** Coerce a JSON cell value into the type Excel should store, so number
 *  formats actually apply (a currency stored as text would not sum). Falls
 *  back to the original value when coercion is not possible — never throws. */
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

  descriptor.sheets.forEach((sheet, index) => {
    const ws = workbook.addWorksheet(sanitizeSheetName(sheet.name, index));
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
      for (const col of sheet.columns) {
        // Computed columns derive their value from the formula template below,
        // not from the row/dataset — leave the cell empty for now.
        coerced[col.key] = col.formula
          ? null
          : coerce(row[col.key] ?? null, col.type);
      }
      const added = ws.addRow(coerced);
      const rowNumber = added.number;
      // Write real Excel formulas explicitly. Cross-sheet references (e.g.
      // `'Offene Posten'!C:C`) and `{row}` row-number substitution resolve on
      // open in Excel/LibreOffice.
      for (const col of sheet.columns) {
        if (col.formula) {
          // Computed column: same formula every row, `{row}` → this row number.
          added.getCell(col.key).value = {
            formula: col.formula.replaceAll('{row}', String(rowNumber)),
          };
          continue;
        }
        const value = coerced[col.key];
        if (isFormulaCell(value)) {
          added.getCell(col.key).value = {
            formula: value.formula,
            ...(value.result !== undefined ? { result: value.result } : {}),
          };
        }
      }
      rowsWritten += 1;
    }
  });

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
