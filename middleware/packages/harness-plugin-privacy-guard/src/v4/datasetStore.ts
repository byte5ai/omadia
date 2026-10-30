/**
 * Privacy Shield v4 — Dataset Store (US1).
 *
 * The turn-scoped, in-memory registry of interned tool results. This is the
 * foundation of guarantee G1: `internToolResult` parses a raw tool result
 * into rows, stores the REAL rows server-side behind an opaque `datasetId`,
 * and hands back only the identity-free Digest. `finalizeTurn` drops every
 * dataset (FR-003).
 *
 * One store instance exists per orchestrator turn — all state lives on the
 * instance, never at module scope (Constitution I).
 *
 * The classifier (US2) and the digest builder (US3) are injected so this
 * module is independently testable before either exists.
 *
 * Contract: specs/001-privacy-shield-v4/contracts/dataset-store-and-digest.md
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_INTERN_CHARS,
  type Classifier,
  type Dataset,
  type DatasetRow,
  type DatasetShape,
  type DatasetStore,
  type Digest,
  type DigestEnvelope,
} from './types.js';

/** Builds the LLM-bound Digest for a stored Dataset. Implemented by US3
 *  (`digest.ts`); injected so the store is testable with a stub. */
export type DigestBuilder = (dataset: Dataset) => Digest;

export interface DatasetStoreDeps {
  /** The Shape Classifier (US2). */
  readonly classify: Classifier;
  /** The Digest builder (US3). */
  readonly buildDigest: DigestBuilder;
  /** The turn this store belongs to — stamped onto every dataset's provenance. */
  readonly turnId: string;
  /** Intern-time size cap; defaults to `MAX_INTERN_CHARS`. Tests override it. */
  readonly maxInternChars?: number;
}

/** The record array + metadata of an envelope-shaped result (see
 *  `expandEnvelope`). Classified into a `DatasetEnvelope` by the store. */
export interface ParsedEnvelope {
  readonly itemsPath: string;
  readonly values: DatasetRow;
}

/** The normalized result of parsing a raw tool result. */
export interface ParsedResult {
  readonly rows: ReadonlyArray<DatasetRow>;
  readonly shape: DatasetShape;
  readonly truncated: boolean;
  /** Set when the result was an envelope; `rows` are then its records. */
  readonly envelope?: ParsedEnvelope;
}

// ---------------------------------------------------------------------------
// Parsing & normalization
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A row is "nested" when any of its values is itself an object or array. */
function rowHasNested(row: Record<string, unknown>): boolean {
  return Object.values(row).some((v) => Array.isArray(v) || isPlainObject(v));
}

/** A non-empty array whose every element is a plain object — i.e. detail rows
 *  hiding inside a wrapper object's field. */
function isRecordArray(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.length > 0 && v.every(isPlainObject);
}

/**
 * The well-known protocol / pagination keys of a result envelope. ONLY these
 * become dataset metadata; they describe the transport of the result (which
 * model, how many, is there more), never a property of a record. Kept small
 * and explicit on purpose — any other sibling scalar is business data (a
 * timesheet's `jahr`/`kw`) that consumers rely on as a per-row column.
 */
export const ENVELOPE_METADATA_KEYS: ReadonlySet<string> = new Set([
  'model',
  'scope',
  'count',
  'total',
  'truncated',
  'limit',
  'offset',
  'page',
  'page_size',
  'pageSize',
  'has_more',
  'hasMore',
  'next',
  'cursor',
  'next_cursor',
]);

/**
 * Is `v` a scalar-equivalent envelope value? Primitives, plus the Odoo
 * many2one `[id, "label"]` tuple (the materializer flattens it to the label).
 * Genuine nested values (objects, other arrays) are dropped — as a column
 * they would only reintroduce the per-cell JSON dump the expansion removes.
 */
function isEnvelopeScalar(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'string'
  );
}

/**
 * Recognize an envelope — one object wrapping the real record array in a
 * single field next to scalar siblings — and promote the records to BE the
 * dataset rows. Generic, not tool-specific: odoo_query's
 * `{ model, scope, count, truncated, records: [ … ] }`, a paged
 * `{ total, items: [ … ] }`, a timesheet `{ jahr, kw, abweichungen_pro_ma:
 * [ … ] }` all qualify, whatever the array key is called. Left as one
 * `nested` row, the array would be a single opaque field rendered as one JSON
 * blob (the timesheet defect this expansion was built for).
 *
 * The scalar siblings split in two:
 *  - a key in `ENVELOPE_METADATA_KEYS` (`count`, `truncated`, `model`, …) is
 *    protocol METADATA — returned in `envelope.values`, never a row column
 *    (v414: broadcasting them made a canvas table published from the dataset,
 *    and the refresh recipe derived from it, show `model, scope, count,
 *    truncated` as columns);
 *  - every other scalar is business data and is copied onto each record as a
 *    column (`jahr`, `kw` — the timesheet plugin renders them), the record's
 *    own field winning a key collision.
 * Nested siblings are dropped.
 *
 * Conservative by design: only fires when the object has EXACTLY ONE
 * record-array field (a non-empty array of plain objects). Zero is an
 * ordinary object (one row); more than one is ambiguous — which is the record
 * table? — and stays ONE `nested` row with every field, no metadata.
 */
function expandEnvelope(
  obj: Record<string, unknown>,
): { rows: Record<string, unknown>[]; envelope: ParsedEnvelope } | undefined {
  const recordKeys = Object.keys(obj).filter((k) => isRecordArray(obj[k]));
  if (recordKeys.length !== 1) return undefined;
  const itemsPath = recordKeys[0] as string;
  const metadata: Record<string, unknown> = {};
  const columns: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (k === itemsPath || !isEnvelopeScalar(val)) continue;
    if (ENVELOPE_METADATA_KEYS.has(k)) metadata[k] = val;
    else columns[k] = val;
  }
  const records = obj[itemsPath] as Record<string, unknown>[];
  return {
    rows: records.map((rec) => ({ ...columns, ...rec })),
    envelope: { itemsPath, values: metadata },
  };
}

/** An object that wraps an empty list and carries nothing else: at least one
 *  empty array, every other field an empty array, `0` (a paging total) or
 *  `null`. `{"datasets":[]}`, `{"items":[],"total":0}`. A record with any
 *  real value (`{name:"Marvin", tag_ids:[]}`) is not one. */
function isEmptyWrapper(obj: Record<string, unknown>): boolean {
  const values = Object.values(obj);
  const isEmptyList = (val: unknown): boolean =>
    Array.isArray(val) && val.length === 0;
  return (
    values.some(isEmptyList) &&
    values.every((val) => isEmptyList(val) || val === 0 || val === null)
  );
}

/** Normalize an arbitrary JS value into a uniform row array + a shape tag.
 *  Non-tabular values are wrapped so the store and the Verb API always
 *  operate on `Record<string, unknown>[]`. */
function normalizeValue(v: unknown): {
  rows: DatasetRow[];
  shape: DatasetShape;
  envelope?: ParsedEnvelope;
} {
  if (Array.isArray(v)) {
    if (v.length === 0) return { rows: [], shape: 'rows' };
    if (v.every(isPlainObject)) {
      const rows = v as Record<string, unknown>[];
      return { rows, shape: rows.some(rowHasNested) ? 'nested' : 'rows' };
    }
    // Array of scalars (or mixed) — wrap each element as a `value` column.
    return { rows: v.map((e) => ({ value: e })), shape: 'rows' };
  }
  if (isPlainObject(v)) {
    // An empty wrapper (`{"datasets":[]}`, `{"items":[],"total":0}`) is
    // "no records", not one record whose only field is an empty array. As
    // one row it got classified `unknown`, masked, and the model rendered a
    // blind, contentless list entry instead of saying there is no data
    // (#1467).
    if (isEmptyWrapper(v)) return { rows: [], shape: 'rows' };
    // Envelope → its records are the rows, its scalars are metadata.
    const expanded = expandEnvelope(v);
    if (expanded !== undefined) {
      return {
        rows: expanded.rows,
        shape: expanded.rows.some(rowHasNested) ? 'nested' : 'rows',
        envelope: expanded.envelope,
      };
    }
    return { rows: [v], shape: rowHasNested(v) ? 'nested' : 'object' };
  }
  return { rows: [{ value: v }], shape: 'scalar' };
}

/** Keep a prefix of whole rows whose combined serialized size stays under
 *  `maxChars`. Always keeps at least the first row when the input is
 *  non-empty, so a single oversized row is retained (and flagged) rather
 *  than dropped. */
function boundRows(
  rows: ReadonlyArray<DatasetRow>,
  maxChars: number,
): { rows: ReadonlyArray<DatasetRow>; truncated: boolean } {
  if (rows.length === 0) return { rows, truncated: false };
  const kept: DatasetRow[] = [];
  let total = 2; // the enclosing `[]`
  for (const row of rows) {
    let size: number;
    try {
      size = JSON.stringify(row).length + 1; // + the row separator
    } catch {
      size = maxChars; // unserializable row — treat as large
    }
    if (kept.length > 0 && total + size > maxChars) break;
    kept.push(row);
    total += size;
  }
  return { rows: kept, truncated: kept.length < rows.length };
}

function normalizeAndBound(value: unknown, maxChars: number): ParsedResult {
  const norm = normalizeValue(value);
  const bounded = boundRows(norm.rows, maxChars);
  return {
    rows: bounded.rows,
    shape: norm.shape,
    truncated: bounded.truncated,
    ...(norm.envelope !== undefined ? { envelope: norm.envelope } : {}),
  };
}

/**
 * Parse a raw tool result into `{ rows, shape, truncated }` (+ `envelope` for
 * an envelope-shaped result, see `expandEnvelope`). Total — never
 * throws: an unparseable value is interned as a single scalar blob.
 *
 *  - A string that is valid JSON is parsed, then normalized + size-bounded.
 *  - A string that is NOT JSON is free text — interned as one scalar row,
 *    the string itself truncated to `maxChars` when oversized.
 *  - A non-string value is normalized + size-bounded directly.
 */
export function parseToolResult(
  rawResult: unknown,
  maxChars: number,
): ParsedResult {
  try {
    if (typeof rawResult === 'string') {
      let parsed: unknown;
      let isJson = false;
      if (rawResult.trim().length > 0) {
        try {
          parsed = JSON.parse(rawResult);
          isJson = true;
        } catch {
          isJson = false;
        }
      }
      if (!isJson) {
        const truncated = rawResult.length > maxChars;
        const text = truncated ? rawResult.slice(0, maxChars) : rawResult;
        return { rows: [{ value: text }], shape: 'scalar', truncated };
      }
      return normalizeAndBound(parsed, maxChars);
    }
    return normalizeAndBound(rawResult, maxChars);
  } catch {
    // Last-resort: intern whatever it was as an opaque scalar blob.
    return { rows: [{ value: String(rawResult) }], shape: 'scalar', truncated: false };
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Create a turn-scoped Dataset Store. The returned object holds all state on
 * its closure — there is no module-scope mutable state. Drop the reference
 * (or call `finalizeTurn`) to release every dataset.
 */
export function createDatasetStore(deps: DatasetStoreDeps): DatasetStore {
  const maxChars = deps.maxInternChars ?? MAX_INTERN_CHARS;
  const datasets = new Map<string, Dataset>();
  let interned = 0;

  function register(dataset: Dataset): DigestEnvelope {
    datasets.set(dataset.datasetId, dataset);
    return { datasetId: dataset.datasetId, digest: deps.buildDigest(dataset) };
  }

  return {
    internToolResult(toolName, rawResult, toolInput): DigestEnvelope {
      const parsed = parseToolResult(rawResult, maxChars);
      const context = { sourceTools: [toolName] };
      const schema = deps.classify(parsed.rows, parsed.shape, context);
      const envelope = parsed.envelope;
      const dataset: Dataset = {
        datasetId: `ds_${randomUUID()}`,
        rows: parsed.rows,
        schema,
        provenance: {
          toolName,
          sourceTools: [toolName],
          turnId: deps.turnId,
          truncated: parsed.truncated,
          createdAt: new Date().toISOString(),
          ...(toolInput !== undefined ? { toolInput } : {}),
        },
        // The metadata is classified on its own (a one-row object) with the
        // same classifier, so masking is identical to a row field's.
        ...(envelope !== undefined
          ? {
              envelope: {
                itemsPath: envelope.itemsPath,
                values: envelope.values,
                schema: deps.classify([envelope.values], 'object', context),
              },
            }
          : {}),
      };
      interned += 1;
      return register(dataset);
    },

    put(dataset): DigestEnvelope {
      return register(dataset);
    },

    get(datasetId): Dataset | undefined {
      return datasets.get(datasetId);
    },

    finalizeTurn(): void {
      datasets.clear();
    },

    get internedCount(): number {
      return interned;
    },
  };
}
