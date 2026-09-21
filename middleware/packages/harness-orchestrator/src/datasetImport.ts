/**
 * CSV → structured dataset import (#430). Shared by both entry points:
 * the `POST /api/v1/datasets` REST route and the chat-attachment
 * auto-ingest branch in {@link ./attachmentExtract.js | attachmentExtract.ts}
 * (via `orchestrator.ts`'s `ingestAttachments`).
 *
 * Pipeline: parse → infer column types → privacy-scan every row → hand the
 * scrubbed rows to `KnowledgeGraph.ingestDataset`. The scan step is
 * mandatory and cannot be bypassed by a caller — there is no "skip privacy"
 * parameter, matching the maintainer-approved plan on issue #430 ("do not
 * skip this or scan headers/sample-only").
 *
 * Scanning uses the SAME `createBaselineDetector()` (C0 regex) pass that
 * protects free-text user prompts today (`@omadia/plugin-privacy-guard`).
 * Only `string`-typed columns are scanned. A `number`/`boolean`/`date`
 * column is, by construction, a cell that parsed cleanly as a
 * number/bool/date for EVERY row — there is no free-text surface left for
 * the regex to match, and running it anyway risks corrupting legitimate
 * data on a false-positive hit (e.g. a 7-digit id that happens to start
 * with a leading `0`, which the phone-number pattern would flag).
 *
 * `date` is skipped for the same structural reason AND a correctness one
 * (#727): masking runs over a *persisted* value here — no pseudonym map is
 * retained after import, so the substitution is irreversible, and a masked
 * date would make the stored value contradict the column's declared `date`
 * type (a `query_dataset` gt/lt/min/max over it would then compare against a
 * surrogate string, returning confidently-wrong answers). A pure date carries
 * no name/email/phone/address on its own, so there is nothing to redact; the
 * real date is stored as-is and the schema stays honest. This is a v1
 * scoping call, not a bypass: every ROW still goes through the pipeline,
 * exactly as the issue requires — only cells the pipeline could not
 * possibly find PII in are skipped.
 *
 * Known residual (documented, not glossed): a column that is a *bare* PII
 * date — e.g. a `birth_date` of ISO dates — is persisted un-redacted, the
 * same class of trade as a national-ID column inferred as `number`. Reversible
 * masking of date columns needs a retained per-dataset pseudonym map, a #430
 * design question tracked as a follow-up, not a blocker for the masker fix.
 *
 * Cost note: this is O(rows × string-columns) baseline-detector calls,
 * each a handful of regex passes over one cell's text — CPU-bound, not
 * network-bound (`createBaselineDetector` never makes an HTTP call), so a
 * few thousand rows costs single-digit milliseconds. If a future GLiNER
 * (C1 transformer) sidecar is wired in for this path — it is NOT, in this
 * change, only the C0 baseline is applied — that additional per-row HTTP
 * hop is the piece worth budgeting for; see the PR description's
 * follow-up-issue note.
 */

import { parse as parseCsvSync } from 'csv-parse/sync';

import {
  createBaselineDetector,
  maskPrompt,
} from '@omadia/plugin-privacy-guard';
import type {
  DatasetColumnSchema,
  DatasetColumnType,
  DatasetIngestResult,
  KnowledgeGraph,
} from '@omadia/plugin-api';

import { encryptCell, type DatasetCellKey } from './datasetCellCrypto.js';
import {
  isLinkKeyColumn,
  linkKeyColumnName,
  type DatasetLinkKeyer,
} from './datasetLinkKey.js';

/** Hard cap on imported rows — protects `dataset_rows` + the per-row
 *  privacy scan from an unbounded upload. Mirrors the spirit of
 *  `MAX_TEXT_CHARS` in `attachmentExtract.ts`: a cap that degrades
 *  gracefully (truncate + report) rather than one that OOMs the process. */
export const MAX_DATASET_ROWS = 50_000;
/** Per-cell char cap BEFORE the privacy scan — an absurdly long single CSV
 *  cell (e.g. a stray multi-KB blob in one field) would otherwise dominate
 *  the scan's cost for no import-quality benefit. Exported so the XLSX
 *  parser caps cells identically; one format must not be able to smuggle a
 *  larger cell past the scan budget than the other. */
export const MAX_CELL_CHARS = 4_000;

/** #430 fixup — per-cell truncation stats. `MAX_CELL_CHARS` still caps every
 *  cell (protects the privacy scan + storage from an absurd single-cell
 *  blob), but silently cutting a 4000+-char cell with no signal contradicted
 *  the PR's "no more silent CSV truncation" claim — this makes the cut
 *  visible instead of removing it (removing it would let one pathological
 *  cell blow the scan/storage budget). */
export interface TableTruncationStats {
  /** Total cells whose raw value exceeded `MAX_CELL_CHARS` and was cut. */
  truncatedCellCount: number;
  /** Column names that had at least one truncated cell, in header order. */
  truncatedColumns: string[];
}

/** A parsed table, format-neutral: header names plus header-keyed string
 *  rows. Both `parseCsv` and the XLSX parser produce exactly this, which is
 *  what lets a spreadsheet reuse the CSV path's type inference and privacy
 *  scan rather than growing a second, subtly-different pipeline. */
export interface TableParse {
  headers: string[];
  rows: Array<Record<string, string>>;
  truncation: TableTruncationStats;
}

export type TableParseResult =
  | ({ ok: true } & TableParse)
  | { ok: false; reason: string };

/** @deprecated Use {@link TableTruncationStats} — kept so existing importers
 *  of the CSV-era name keep compiling. */
export type CsvTruncationStats = TableTruncationStats;
/** @deprecated Use {@link TableParseResult}. */
export type CsvParseResult = TableParseResult;

/** Parse CSV bytes into header-keyed string rows. Never throws — a
 *  malformed CSV (ragged rows, empty file, encoding garbage) resolves to
 *  `{ ok: false, reason }` so callers can surface a clean 4xx/tool-error
 *  instead of a 500 / unhandled rejection. */
export function parseCsv(bytes: Buffer): CsvParseResult {
  let records: unknown;
  try {
    records = parseCsvSync(bytes, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (err) {
    return {
      ok: false,
      reason: `invalid CSV — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: 'CSV has no data rows' };
  }
  const first = records[0];
  if (typeof first !== 'object' || first === null) {
    return { ok: false, reason: 'CSV did not parse into row objects' };
  }
  const headers = Object.keys(first as Record<string, unknown>);
  if (headers.length === 0) {
    return { ok: false, reason: 'CSV header row is empty' };
  }
  if (records.length > MAX_DATASET_ROWS) {
    return {
      ok: false,
      reason: `CSV has ${String(records.length)} rows, exceeding the ${String(MAX_DATASET_ROWS)}-row import cap`,
    };
  }
  let truncatedCellCount = 0;
  const truncatedColumnSet = new Set<string>();
  const rows = (records as Array<Record<string, unknown>>).map((record) => {
    const row: Record<string, string> = {};
    for (const h of headers) {
      const v = record[h];
      const full = v === undefined || v === null ? '' : String(v);
      if (full.length > MAX_CELL_CHARS) {
        truncatedCellCount += 1;
        truncatedColumnSet.add(h);
      }
      row[h] = full.slice(0, MAX_CELL_CHARS);
    }
    return row;
  });
  return {
    ok: true,
    headers,
    rows,
    truncation: {
      truncatedCellCount,
      truncatedColumns: headers.filter((h) => truncatedColumnSet.has(h)),
    },
  };
}

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const BOOLEAN_RE = /^(?:true|false)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?)?$|^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/i;
/** A pure-digit value with a leading zero (`'0301234567'`, `'01234'`), or its
 *  negative counterpart (`'-0123'`), is a zero-padded identifier — phone
 *  number, postal code, account number — not a number. `Number()` silently
 *  drops the leading zero, corrupting the
 *  value, and a column typed `'number'` skips the mandatory privacy scan
 *  (see module doc), so such a column must NOT be inferred as `'number'`.
 *  A bare `'0'` or a `'0.x'` decimal is still a legitimate number and is
 *  intentionally excluded from this pattern (with or without a leading
 *  minus sign). */
const LEADING_ZERO_RE = /^-?0\d/;

/** Infer one column's type from every non-empty value across all rows —
 *  ALL values must agree for a type to win; a single non-conforming cell
 *  falls the column back to `'string'` (the safe default that never
 *  mis-parses). Empty-only columns default to `'string'`. A column that
 *  otherwise looks numeric but contains any zero-padded value (leading
 *  zero) is also forced to `'string'` — see `LEADING_ZERO_RE`. */
function inferColumnType(values: readonly string[]): DatasetColumnType {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v.length > 0);
  if (nonEmpty.length === 0) return 'string';
  if (
    nonEmpty.every((v) => NUMBER_RE.test(v)) &&
    !nonEmpty.some((v) => LEADING_ZERO_RE.test(v))
  ) {
    return 'number';
  }
  if (nonEmpty.every((v) => BOOLEAN_RE.test(v))) return 'boolean';
  if (nonEmpty.every((v) => DATE_RE.test(v))) return 'date';
  return 'string';
}

export interface PrivacyScanStats {
  /** Total cells (across every row) that were passed through the baseline
   *  detector — string-typed columns only, see module doc. */
  scannedCells: number;
  /** Cells where the scan found at least one PII span. With a cell key these
   *  are stored ENCRYPTED (real value, server-side readable); without one
   *  they are masked irreversibly as before. */
  maskedCells: number;
  /** True when flagged cells were encrypted rather than masked — i.e. the
   *  real values are recoverable server-side for rendering and export. */
  encryptedAtRest: boolean;
}

/**
 * Full pipeline: parse → infer schema → privacy-scan every row →
 * type-coerce. Returns the scrubbed rows ready for
 * `KnowledgeGraph.ingestDataset` plus the inferred column schema. The
 * privacy scan runs unconditionally — there is no flag to skip it.
 */
export type BuildDatasetResult =
  | {
      ok: true;
      columns: DatasetColumnSchema[];
      rows: Array<Record<string, unknown>>;
      privacyScan: PrivacyScanStats;
      truncation: TableTruncationStats;
      linkKeys: LinkKeyReport;
    }
  | { ok: false; reason: string };

export interface BuildDatasetOptions {
  /** When set, every `string` column additionally gets a `__k_<column>`
   *  link-key column (see `datasetLinkKey.ts`), computed from the RAW cell
   *  before masking. Absent ⇒ no key columns, byte-identical pre-link-key
   *  output. */
  linkKey?: DatasetLinkKeyer;
  /** When set, a cell the PII scan flags is stored as its REAL value under
   *  AES-256-GCM (`enc1:…`, see `datasetCellCrypto.ts`) instead of the
   *  irreversible surrogate. Absent ⇒ masking as before. */
  cellKey?: DatasetCellKey;
}

export interface LinkKeyReport {
  /** Link-key column names written, in schema order. Empty when no keyer
   *  was supplied or no column qualified. */
  columns: string[];
}

/** CSV bytes → scrubbed dataset. Thin wrapper over
 *  {@link buildDatasetFromTable}; the pipeline itself is format-neutral. */
export async function buildDatasetFromCsv(
  bytes: Buffer,
  opts: BuildDatasetOptions = {},
): Promise<BuildDatasetResult> {
  const parsed = parseCsv(bytes);
  if (!parsed.ok) return parsed;
  return buildDatasetFromTable(parsed, opts);
}

/**
 * Which columns get a link key: every `string`-typed one — not just the
 * masked ones. The C0 baseline that runs here does not detect person names,
 * so a `Name` column is unmasked at import yet still refused as a verb key
 * downstream (the v4 shape classifier masks multi-word strings). Keying only
 * masked columns would therefore miss the single most common dedup key.
 * Number/boolean/date columns are already safe keys and need none.
 *
 * The `__k_` namespace is reserved (see {@link reservedHeader}), so a key
 * name can never collide with a real header here.
 */
function selectLinkKeyColumns(
  headers: ReadonlyArray<string>,
  columnTypes: ReadonlyMap<string, DatasetColumnType>,
): Set<string> {
  const keyed = new Set<string>();
  for (const header of headers) {
    if (columnTypes.get(header) === 'string') keyed.add(header);
  }
  return keyed;
}

/**
 * A header in the reserved `__k_` namespace is refused outright — with or
 * without link keys enabled. Accepting it would make the tool description's
 * promise ("every `__k_` column is a link key") false for that file, and the
 * `[dataset-imported]` fact ("Link-key columns: none") would contradict
 * `get_schema`. The uploader is the owner, so this is not a leak; it is a
 * consistency guarantee the model's dedup recipe relies on.
 */
function reservedHeader(headers: ReadonlyArray<string>): string | undefined {
  return headers.find(isLinkKeyColumn);
}

/**
 * The shared pipeline every tabular format lands on: infer schema →
 * privacy-scan every string cell → type-coerce. Taking an already-parsed
 * {@link TableParse} rather than raw bytes is what guarantees CSV and XLSX
 * get byte-identical privacy treatment — there is exactly one implementation
 * of "which cells get scanned", and neither format can opt out of it.
 */
export async function buildDatasetFromTable(
  parsed: TableParse,
  opts: BuildDatasetOptions = {},
): Promise<BuildDatasetResult> {
  const reserved = reservedHeader(parsed.headers);
  if (reserved !== undefined) {
    return {
      ok: false,
      reason: `column name "${reserved}" uses the reserved "__k_" prefix (link-key columns are generated on import) — rename the column and upload again`,
    };
  }

  const columnTypes = new Map<string, DatasetColumnType>();
  for (const header of parsed.headers) {
    columnTypes.set(
      header,
      inferColumnType(parsed.rows.map((r) => r[header] ?? '')),
    );
  }

  const linkKey = opts.linkKey;
  const keyedColumns = linkKey
    ? selectLinkKeyColumns(parsed.headers, columnTypes)
    : new Set<string>();

  const detectors = [createBaselineDetector()];
  const cellKey = opts.cellKey;
  let scannedCells = 0;
  let maskedCells = 0;
  // Display-safe value of every column in the FIRST row — the schema sample.
  // A flagged cell's stored value is now a ciphertext, which tells a human
  // nothing; the sample keeps showing the masked surrogate instead.
  const firstRowDisplay: Record<string, unknown> = {};

  const scrubbedRows: Array<Record<string, unknown>> = [];
  for (const rawRow of parsed.rows) {
    const isFirstRow = scrubbedRows.length === 0;
    const outRow: Record<string, unknown> = {};
    for (const header of parsed.headers) {
      const type = columnTypes.get(header) ?? 'string';
      const raw = rawRow[header] ?? '';
      if (type === 'number') {
        outRow[header] = raw.trim() === '' ? null : Number(raw);
        if (isFirstRow) firstRowDisplay[header] = outRow[header];
        continue;
      }
      if (type === 'boolean') {
        outRow[header] = raw.trim() === '' ? null : /^true$/i.test(raw.trim());
        if (isFirstRow) firstRowDisplay[header] = outRow[header];
        continue;
      }
      if (type === 'date') {
        // Skipped like number/boolean: no free-text surface, and masking a
        // persisted date is irreversible + contradicts the declared type
        // (#727). Store the real date so the schema and the data agree.
        outRow[header] = raw.trim() === '' ? null : raw;
        if (isFirstRow) firstRowDisplay[header] = outRow[header];
        continue;
      }
      // 'string' — the only cells that can carry free text, so the only ones
      // that go through the privacy scan (see module doc).
      scannedCells += 1;
      let display = raw;
      if (raw.length === 0) {
        outRow[header] = raw;
      } else {
        const scanned = await maskPrompt(raw, detectors);
        if (scanned.maskedText !== raw) {
          maskedCells += 1;
          display = scanned.maskedText;
          // A flagged cell keeps its REAL value — encrypted, readable only
          // server-side for the entitled user (render, Excel). Without a key
          // the irreversible surrogate is stored, exactly as before.
          outRow[header] = cellKey ? encryptCell(cellKey, header, raw) : scanned.maskedText;
        } else {
          outRow[header] = raw;
        }
      }
      if (isFirstRow) firstRowDisplay[header] = display;
      // The link key is computed from the RAW value — that is the whole
      // point: it must be the same for the same person in every file, and
      // the masked surrogate is not. The raw value never leaves this
      // function; only the keyed digest does. `null` (not `''`) for a blank
      // cell, so the v4 shape classifier's "every value is a token" check
      // still holds for the key column.
      if (linkKey && keyedColumns.has(header)) {
        outRow[linkKeyColumnName(header)] = linkKey(raw);
      }
    }
    scrubbedRows.push(outRow);
  }

  const describeColumn = (
    name: string,
    type: DatasetColumnType,
  ): DatasetColumnSchema => {
    const sampleValue = firstRowDisplay[name];
    const sample =
      sampleValue === null || sampleValue === undefined
        ? undefined
        : String(sampleValue).slice(0, 200);
    return { name, type, ...(sample !== undefined ? { sample } : {}) };
  };
  // A key column sits right after its source column, so a schema listing
  // reads `Name, __k_Name, E-Mail, __k_E-Mail, …`.
  const linkKeyColumns: string[] = [];
  const columns: DatasetColumnSchema[] = parsed.headers.flatMap((name) => {
    const type = columnTypes.get(name) ?? 'string';
    const own = describeColumn(name, type);
    if (!keyedColumns.has(name)) return [own];
    const keyName = linkKeyColumnName(name);
    linkKeyColumns.push(keyName);
    // No `sample` for a key column: the schema is the one place a key value
    // would surface without the model asking for rows, and a sample of an
    // opaque token tells a human nothing anyway.
    return [own, { name: keyName, type: 'string' }];
  });

  return {
    ok: true,
    columns,
    rows: scrubbedRows,
    privacyScan: { scannedCells, maskedCells, encryptedAtRest: cellKey !== undefined },
    truncation: parsed.truncation,
    linkKeys: { columns: linkKeyColumns },
  };
}

export interface ImportCsvDatasetInput {
  graph: KnowledgeGraph;
  bytes: Buffer;
  datasetName: string;
  sourceFileName: string;
  ownerOmadiaUserId: string;
  sourceStorageKey?: string;
}

export type ImportCsvDatasetResult =
  | {
      ok: true;
      result: DatasetIngestResult;
      privacyScan: PrivacyScanStats;
      truncation: CsvTruncationStats;
    }
  | { ok: false; reason: string };

/** End-to-end: CSV bytes → privacy-scrubbed rows → persisted dataset. The
 *  single function both entry points (REST route, chat-attachment
 *  auto-ingest) call, so the pipeline can never be invoked with the scan
 *  step skipped from one of the two paths but not the other. */
export async function importCsvDataset(
  input: ImportCsvDatasetInput,
): Promise<ImportCsvDatasetResult> {
  const built = await buildDatasetFromCsv(input.bytes);
  if (!built.ok) return built;
  const result = await input.graph.ingestDataset({
    ownerOmadiaUserId: input.ownerOmadiaUserId,
    name: input.datasetName,
    sourceFileName: input.sourceFileName,
    ...(input.sourceStorageKey
      ? { sourceStorageKey: input.sourceStorageKey }
      : {}),
    columns: built.columns,
    rows: built.rows,
  });
  return { ok: true, result, privacyScan: built.privacyScan, truncation: built.truncation };
}
