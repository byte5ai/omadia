import { z } from 'zod';

/**
 * Descriptor contracts for the office renderers.
 *
 * Design rule — the determinism boundary: the document *content* is authored
 * by the LLM (M1) or pulled from a system of record (M3, Phase B), but the
 * *rendering* of a validated descriptor to bytes is deterministic. These Zod
 * schemas are that contract. The renderer never invents data; it lays out
 * exactly what the descriptor (or, in Phase B, the referenced dataset) holds.
 */

export const MEDIA_TYPE = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/**
 * A formula cell. The renderer writes `formula` verbatim as the cell's Excel
 * formula. Cross-sheet references work by writing the sheet name into the
 * formula, e.g. `SUMIFS('Offene Posten'!E:E, 'Offene Posten'!C:C, A2)`.
 * Formulas use the file format's grammar: English function names and `,`
 * between arguments, whatever language the spreadsheet application runs in.
 *
 * Nothing on the server evaluates a formula (exceljs only serialises it), and
 * the cell carries no cached value: the workbook asks the opening application
 * to recalculate on load, and that application computes what is displayed.
 * There is deliberately no `result` field. A caller-supplied cache would be
 * stored as if it were the computed figure; an input that still sends one
 * loses it here (unknown keys are stripped) and the renderer ignores it too.
 */
export const FormulaCellSchema = z.object({
  formula: z.string().min(1).max(4000),
});
export type FormulaCell = z.infer<typeof FormulaCellSchema>;

export const CellValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  FormulaCellSchema,
]);
export type CellValue = z.infer<typeof CellValueSchema>;

/** True for a {@link FormulaCell} (object carrying a `formula` string). */
export function isFormulaCell(value: unknown): value is FormulaCell {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { formula?: unknown }).formula === 'string'
  );
}

export const ColumnTypeSchema = z.enum([
  'text',
  'number',
  'currency',
  'date',
  'percent',
]);
export type ColumnType = z.infer<typeof ColumnTypeSchema>;

export const ColumnSpecSchema = z.object({
  /** Row-object key this column reads from. */
  key: z.string().min(1).max(120),
  /** Header label rendered in row 1. */
  header: z.string().min(1).max(200),
  /** Drives the Excel number format when `numFmt` is not given. */
  type: ColumnTypeSchema.optional(),
  /** Column width in characters. */
  width: z.number().positive().max(255).optional(),
  /** Explicit Excel number-format string; overrides `type`. */
  numFmt: z.string().max(64).optional(),
  /** ISO currency code for `type: 'currency'` (e.g. `EUR`). Default `EUR`. */
  currency: z.string().min(1).max(8).optional(),
  /**
   * Computed column: a per-row Excel formula template. When set, the column's
   * value is NOT read from the row/dataset — every data row gets this formula,
   * with the placeholder `{row}` replaced by that row's Excel row number. This
   * is what lets a DATASET sheet carry a helper column, e.g. a "Monat" column
   * `formula: 'YEAR(C{row})&"-"&TEXT(MONTH(C{row}),"00")'` (C = the date
   * column's letter; built from YEAR/MONTH because TEXT date codes such as
   * "YYYY" are read in the opening application's language). Other columns
   * are referenced by their Excel letter (A, B, C… in column order). Like a
   * formula cell, it is written without a cached value.
   */
  formula: z.string().min(1).max(2000).optional(),
});
export type ColumnSpec = z.infer<typeof ColumnSpecSchema>;

/**
 * A single worksheet. In this phase rows are carried inline (M1 —
 * LLM-authored, small). Phase B adds an optional `datasetId` (and makes
 * `rows` optional) to pull rows from a server-side resolved dataset (M3)
 * without routing them through the LLM context — an additive change.
 */
export const SheetSpecSchema = z.object({
  // Excel caps sheet names at 31 chars and forbids a few characters; we keep
  // the length cap here and sanitize the forbidden chars in the renderer.
  name: z.string().min(1).max(31),
  columns: z.array(ColumnSpecSchema).min(1).max(256),
  rows: z.array(z.record(z.string(), CellValueSchema)),
});
export type SheetSpec = z.infer<typeof SheetSpecSchema>;

export const XlsxDescriptorSchema = z.object({
  filename: z.string().min(1).max(120).optional(),
  title: z.string().max(200).optional(),
  sheets: z.array(SheetSpecSchema).min(1).max(32),
});
/** Normalized renderer input — every sheet has concrete inline `rows`. The
 *  tool boundary resolves any dataset source into this shape first. */
export type XlsxDescriptor = z.infer<typeof XlsxDescriptorSchema>;

// --- Tool-facing input (M1 inline OR M3 dataset) ---------------------------

/**
 * LLM-facing sheet: carries EITHER inline `rows` (M1 — model-authored) OR a
 * `datasetId` (M3 — a privacy-guard dataset the model saw referenced in a
 * sub-agent's data digest). Exactly one must be present. For the dataset case
 * the data never reaches the model: the tool resolves the id to real rows
 * server-side and renders them. Column `key` maps to the dataset field path.
 */
export const XlsxToolSheetSchema = z
  .object({
    name: z.string().min(1).max(31),
    columns: z.array(ColumnSpecSchema).min(1).max(256),
    rows: z.array(z.record(z.string(), CellValueSchema)).optional(),
    datasetId: z.string().min(1).max(200).optional(),
  })
  .superRefine((sheet, ctx) => {
    const hasRows = sheet.rows !== undefined;
    const hasDataset = sheet.datasetId !== undefined;
    if (hasRows === hasDataset) {
      ctx.addIssue({
        code: 'custom',
        message: `sheet "${sheet.name}": provide exactly one of "rows" (inline) or "datasetId" (server-side dataset)`,
      });
    }
  });
export type XlsxToolSheet = z.infer<typeof XlsxToolSheetSchema>;

export const XlsxToolInputSchema = z.object({
  filename: z.string().min(1).max(120).optional(),
  title: z.string().max(200).optional(),
  sheets: z.array(XlsxToolSheetSchema).min(1).max(32),
});
export type XlsxToolInput = z.infer<typeof XlsxToolInputSchema>;

/** A datasetId resolved to its real rows + schema, handed to the office tool
 *  by the host (adapter over the privacy provider). Structurally mirrors
 *  plugin-api's `PrivacyResolvedDataset` but defined locally so the package
 *  does not couple to the privacy contract. */
export interface OfficeResolvedDataset {
  readonly rowCount: number;
  readonly columns: ReadonlyArray<{ readonly path: string; readonly type: string }>;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
}

/** Resolves a datasetId to its real rows within the current turn. Returns
 *  undefined for an unknown/expired id. Server-side only. */
export type OfficeDatasetResolver = (
  turnId: string,
  datasetId: string,
) => OfficeResolvedDataset | undefined;

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

export const DocxBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    level: z.number().int().min(1).max(4),
    text: z.string().max(2000),
  }),
  z.object({ type: z.literal('paragraph'), text: z.string().max(20000) }),
  z.object({
    type: z.literal('bullets'),
    items: z.array(z.string().max(2000)).min(1).max(500),
  }),
  z.object({
    type: z.literal('table'),
    headers: z.array(z.string().max(500)).min(1).max(50),
    rows: z.array(z.array(z.string().max(2000))).max(5000),
  }),
]);
export type DocxBlock = z.infer<typeof DocxBlockSchema>;

export const DocxDescriptorSchema = z.object({
  filename: z.string().min(1).max(120).optional(),
  title: z.string().max(200).optional(),
  blocks: z.array(DocxBlockSchema).min(1).max(2000),
});
export type DocxDescriptor = z.infer<typeof DocxDescriptorSchema>;

// ---------------------------------------------------------------------------
// Render + service result shapes
// ---------------------------------------------------------------------------

/** Raw render output before persistence. */
export interface RenderResult {
  readonly buffer: Buffer;
  readonly mediaType: string;
  readonly ext: 'xlsx' | 'docx';
  /** Sanitized download name including the extension. */
  readonly filename: string;
  /** Data rows written (excludes the header). Powers the postcondition. */
  readonly rowsWritten: number;
}

/** Payload carried inside the `NativeToolAttachment` (kind: `'file'`) that the
 *  orchestrator's attachment drain downcasts and maps onto an
 *  `OutgoingAttachment`. Kept structurally aligned with `OutgoingAttachment`
 *  so the mapping is a 1:1 field copy. */
export interface OfficeFileAttachmentPayload {
  readonly url: string;
  readonly altText: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly producer: string;
}

/** What the service hands back after store + sign. */
export interface OfficeArtifact {
  readonly url: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly rowsWritten: number;
  /** True when the content-addressed object already existed in Tigris. */
  readonly cacheHit: boolean;
}

/** Fixed epoch stamped into document metadata so the same descriptor yields
 *  the same logical document (no wall-clock leakage). Byte-identical repro is
 *  explicitly out of scope — the OOXML zip still embeds its own entry order. */
export const DETERMINISTIC_EPOCH = new Date(0);

export class OfficeRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeRenderError';
  }
}

/**
 * A descriptor formula the formula policy refuses (`formulaPolicy.ts`): one
 * that would reach outside the workbook (the network, another program or
 * another file), or one that calls a function other than Excel's own. Thrown
 * before any byte is written, so nothing is stored or delivered.
 */
export class OfficeUnsafeFormulaError extends OfficeRenderError {
  constructor(
    /** Where the formula sits, e.g. `sheet "Pivot", cell B2`. */
    public readonly location: string,
    /** Why it was refused, phrased for the caller (and the model). */
    public readonly reason: string,
  ) {
    super(
      `formula in ${location} rejected: ${reason}. Formulas may only compute over cells of this workbook.`,
    );
    this.name = 'OfficeUnsafeFormulaError';
  }
}

export class OfficePostconditionError extends Error {
  constructor(
    public readonly expectedRows: number,
    public readonly actualRows: number,
  ) {
    super(
      `postcondition failed — wrote ${String(actualRows)} of ${String(expectedRows)} rows`,
    );
    this.name = 'OfficePostconditionError';
  }
}
