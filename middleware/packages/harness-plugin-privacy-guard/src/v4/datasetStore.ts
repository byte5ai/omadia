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

/** The normalized result of parsing a raw tool result. */
export interface ParsedResult {
  readonly rows: ReadonlyArray<DatasetRow>;
  readonly shape: DatasetShape;
  readonly truncated: boolean;
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

/** Normalize an arbitrary JS value into a uniform row array + a shape tag.
 *  Non-tabular values are wrapped so the store and the Verb API always
 *  operate on `Record<string, unknown>[]`. */
function normalizeValue(v: unknown): {
  rows: DatasetRow[];
  shape: DatasetShape;
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

/**
 * Parse a raw tool result into `{ rows, shape, truncated }`. Total — never
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
      const norm = normalizeValue(parsed);
      const bounded = boundRows(norm.rows, maxChars);
      return {
        rows: bounded.rows,
        shape: norm.shape,
        truncated: bounded.truncated,
      };
    }
    const norm = normalizeValue(rawResult);
    const bounded = boundRows(norm.rows, maxChars);
    return {
      rows: bounded.rows,
      shape: norm.shape,
      truncated: bounded.truncated,
    };
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
    internToolResult(toolName, rawResult): DigestEnvelope {
      const parsed = parseToolResult(rawResult, maxChars);
      const schema = deps.classify(parsed.rows, parsed.shape);
      const dataset: Dataset = {
        datasetId: `ds_${randomUUID()}`,
        rows: parsed.rows,
        schema,
        provenance: {
          toolName,
          turnId: deps.turnId,
          truncated: parsed.truncated,
          createdAt: new Date().toISOString(),
        },
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

    allDatasets(): ReadonlyArray<Dataset> {
      return [...datasets.values()];
    },

    finalizeTurn(): void {
      datasets.clear();
    },

    get internedCount(): number {
      return interned;
    },
  };
}
