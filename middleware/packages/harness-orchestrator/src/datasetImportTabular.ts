/**
 * Format-dispatching tabular import — the single entry point both callers
 * use (`orchestrator.ts`'s chat-attachment auto-ingest and the
 * `POST /api/v1/datasets` REST route).
 *
 * Layering (no cycles): `datasetImport.ts` owns CSV parsing plus the shared
 * privacy pipeline, `datasetImportXlsx.ts` owns XLSX parsing, and this
 * module sits above both and performs the `KnowledgeGraph.ingestDataset`
 * write. Adding a third format means adding a parser that returns
 * `TableParse` and one branch here — the privacy scan is not a thing a new
 * format can re-implement or skip.
 *
 * A workbook produces ONE DATASET PER SHEET. Collapsing sheets into a
 * single dataset would either drop data (first sheet only) or invent a
 * union schema across incompatible headers; both are silent data loss at the
 * exact moment a user believes their file was understood.
 */

import type { DatasetColumnSchema, KnowledgeGraph } from '@omadia/plugin-api';

import {
  buildDatasetFromTable,
  parseCsv,
  type PrivacyScanStats,
  type TableParse,
  type TableTruncationStats,
} from './datasetImport.js';
import { parseXlsx } from './datasetImportXlsx.js';
import type { DatasetIngestResult } from '@omadia/plugin-api';

export type TabularFormat = 'csv' | 'xlsx';

export interface ImportTabularDatasetInput {
  graph: KnowledgeGraph;
  bytes: Buffer;
  /** Base name; sheet names are appended when a workbook has several. */
  datasetName: string;
  sourceFileName: string;
  ownerOmadiaUserId: string;
  sourceStorageKey?: string;
  format: TabularFormat;
}

export interface ImportedTable {
  result: DatasetIngestResult;
  privacyScan: PrivacyScanStats;
  truncation: TableTruncationStats;
  /** Present only for multi-sheet workbooks. */
  sheetName?: string;
}

export type ImportTabularDatasetResult =
  | { ok: true; imported: ImportedTable[] }
  | { ok: false; reason: string };

/** One named table awaiting ingest. */
interface NamedTable {
  table: TableParse;
  datasetName: string;
  sheetName?: string;
}

/** Parse bytes into the set of tables the file contains. */
async function parseTables(
  input: ImportTabularDatasetInput,
): Promise<{ ok: true; tables: NamedTable[] } | { ok: false; reason: string }> {
  if (input.format === 'csv') {
    const parsed = parseCsv(input.bytes);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      tables: [{ table: parsed, datasetName: input.datasetName }],
    };
  }

  const parsed = await parseXlsx(input.bytes);
  if (!parsed.ok) return parsed;
  const multi = parsed.sheets.length > 1;
  return {
    ok: true,
    tables: parsed.sheets.map((sheet) => ({
      table: sheet,
      // Single-sheet workbooks keep the plain file name, so the common case
      // reads exactly like a CSV import.
      datasetName: multi
        ? `${input.datasetName} — ${sheet.sheetName}`
        : input.datasetName,
      ...(multi ? { sheetName: sheet.sheetName } : {}),
    })),
  };
}

/**
 * End-to-end: bytes → parsed table(s) → privacy-scrubbed rows → persisted
 * dataset(s). Fails as a unit: if any sheet cannot be built, nothing is
 * ingested, so a caller never sees a half-imported workbook it would then
 * describe to the user as complete.
 */
export async function importTabularDataset(
  input: ImportTabularDatasetInput,
): Promise<ImportTabularDatasetResult> {
  const parsed = await parseTables(input);
  if (!parsed.ok) return parsed;

  // Build (parse + scan) every table BEFORE writing any of them, so a
  // workbook whose third sheet is malformed does not leave the first two
  // persisted under a "failed" result the caller then reports as nothing
  // having happened.
  interface BuiltTable {
    named: NamedTable;
    columns: DatasetColumnSchema[];
    rows: Array<Record<string, unknown>>;
    privacyScan: PrivacyScanStats;
    truncation: TableTruncationStats;
  }
  const built: BuiltTable[] = [];
  for (const named of parsed.tables) {
    const dataset = await buildDatasetFromTable(named.table);
    if (!dataset.ok) {
      const where = named.sheetName ? ` (sheet '${named.sheetName}')` : '';
      return { ok: false, reason: `${dataset.reason}${where}` };
    }
    built.push({
      named,
      columns: dataset.columns,
      rows: dataset.rows,
      privacyScan: dataset.privacyScan,
      truncation: dataset.truncation,
    });
  }

  const imported: ImportedTable[] = [];
  for (const { named, ...dataset } of built) {
    const result = await input.graph.ingestDataset({
      ownerOmadiaUserId: input.ownerOmadiaUserId,
      name: named.datasetName,
      sourceFileName: input.sourceFileName,
      ...(input.sourceStorageKey
        ? { sourceStorageKey: input.sourceStorageKey }
        : {}),
      columns: dataset.columns,
      rows: dataset.rows,
    });
    imported.push({
      result,
      privacyScan: dataset.privacyScan,
      truncation: dataset.truncation,
      ...(named.sheetName ? { sheetName: named.sheetName } : {}),
    });
  }

  return { ok: true, imported };
}
