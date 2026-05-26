/**
 * Privacy Shield v4 — Verb API (US5).
 *
 * The server-side operations the LLM *composes* over `datasetId`s — it never
 * executes them and never sees a row (guarantee G2). Each verb resolves its
 * input Dataset from the turn store, computes new rows in trusted code, and
 * registers a new Dataset, returning a `VerbResult` (`datasetId` + Digest).
 * Because every result is itself a `datasetId`, verbs compose.
 *
 * Contract: specs/001-privacy-shield-v4/contracts/verb-api.md
 */

import { randomUUID } from 'node:crypto';
import {
  type AggregateOp,
  type Classifier,
  type Dataset,
  type DatasetRow,
  type DatasetSchema,
  type DatasetStore,
  type FieldClassification,
  type Predicate,
  type SortDirection,
  type VerbResult,
} from '../types.js';
import { VerbError, evaluatePredicate, validatePredicate } from './predicate.js';

export { VerbError } from './predicate.js';

export interface VerbEngineDeps {
  readonly store: DatasetStore;
  readonly classify: Classifier;
}

export interface AggregateParams {
  /** Optional grouping keys — must be `safe-cleartext` fields. Omitted ⇒ one
   *  output row aggregating the whole dataset. */
  readonly groupBy?: ReadonlyArray<string>;
  readonly ops: ReadonlyArray<AggregateOp>;
}

export interface VerbEngine {
  filter(input: string, predicate: Predicate): VerbResult;
  sort(input: string, by: string, direction?: SortDirection): VerbResult;
  topN(input: string, n: number, by: string, direction?: SortDirection): VerbResult;
  group(input: string, by: ReadonlyArray<string>): VerbResult;
  aggregate(input: string, params: AggregateParams): VerbResult;
  select(input: string, columns: ReadonlyArray<string>): VerbResult;
  count(input: string): VerbResult;
  join(
    left: string,
    right: string,
    on: { readonly left: string; readonly right: string },
  ): VerbResult;
}

// --- pure helpers ----------------------------------------------------------

/** Three-way compare; nulls sort last. */
function compareUnknown(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  if (a === null || a === undefined) {
    return b === null || b === undefined ? 0 : 1;
  }
  if (b === null || b === undefined) return -1;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Project a row down to a set of columns. */
function pick(row: DatasetRow, keys: ReadonlyArray<string>): DatasetRow {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

/** Apply one aggregate op over a group's rows. */
function applyAggregate(op: AggregateOp, rows: ReadonlyArray<DatasetRow>): number {
  if (op.fn === 'count') return rows.length;
  const fieldPath = op.field;
  if (fieldPath === undefined) {
    throw new VerbError(`aggregate "${op.fn}" requires a field`);
  }
  const nums = rows
    .map((r) => r[fieldPath])
    .filter((v): v is number => typeof v === 'number');
  if (op.fn === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (op.fn === 'avg') {
    return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  if (op.fn === 'min') return nums.length === 0 ? 0 : Math.min(...nums);
  return nums.length === 0 ? 0 : Math.max(...nums); // max
}

// --- engine ----------------------------------------------------------------

/**
 * Create the Verb engine. Verbs run on the real datasets in `deps.store`;
 * outputs are classified with `deps.classify` and registered as new datasets.
 */
export function createVerbEngine(deps: VerbEngineDeps): VerbEngine {
  function resolve(id: string): Dataset {
    const ds = deps.store.get(id);
    if (ds === undefined) throw new VerbError(`unknown datasetId "${id}"`);
    return ds;
  }

  function field(schema: DatasetSchema, path: string): FieldClassification {
    const f = schema.fields.find((x) => x.path === path);
    if (f === undefined) throw new VerbError(`unknown field "${path}"`);
    return f;
  }

  function requireSafe(schema: DatasetSchema, path: string): FieldClassification {
    const f = field(schema, path);
    if (f.classification !== 'safe-cleartext') {
      throw new VerbError(
        `field "${path}" is masked — it cannot be used as a key or predicate`,
      );
    }
    return f;
  }

  function requireNumeric(schema: DatasetSchema, path: string): void {
    if (requireSafe(schema, path).type !== 'number') {
      throw new VerbError(`aggregate field "${path}" must be numeric`);
    }
  }

  function derive(source: Dataset, verb: string, rows: DatasetRow[]): VerbResult {
    return deps.store.put({
      datasetId: `ds_${randomUUID()}`,
      rows,
      schema: deps.classify(rows, 'rows'),
      provenance: {
        toolName: verb,
        turnId: source.provenance.turnId,
        derivedFrom: source.datasetId,
        truncated: false,
        createdAt: new Date().toISOString(),
      },
    });
  }

  return {
    filter(input, predicate): VerbResult {
      const ds = resolve(input);
      validatePredicate(predicate, ds.schema);
      return derive(
        ds,
        'filter',
        ds.rows.filter((r) => evaluatePredicate(predicate, r)),
      );
    },

    sort(input, by, direction = 'asc'): VerbResult {
      const ds = resolve(input);
      field(ds.schema, by);
      const mul = direction === 'desc' ? -1 : 1;
      const rows = [...ds.rows].sort(
        (a, b) => compareUnknown(a[by], b[by]) * mul,
      );
      return derive(ds, 'sort', rows);
    },

    topN(input, n, by, direction = 'desc'): VerbResult {
      if (!Number.isInteger(n) || n < 0) {
        throw new VerbError(
          `top_n requires a non-negative integer n, got ${String(n)}`,
        );
      }
      const ds = resolve(input);
      field(ds.schema, by);
      const mul = direction === 'desc' ? -1 : 1;
      const rows = [...ds.rows]
        .sort((a, b) => compareUnknown(a[by], b[by]) * mul)
        .slice(0, n);
      return derive(ds, 'top_n', rows);
    },

    group(input, by): VerbResult {
      const ds = resolve(input);
      for (const b of by) requireSafe(ds.schema, b);
      const seen = new Set<string>();
      const rows: DatasetRow[] = [];
      for (const r of ds.rows) {
        const key = JSON.stringify(by.map((b) => r[b] ?? null));
        if (!seen.has(key)) {
          seen.add(key);
          rows.push(pick(r, by));
        }
      }
      return derive(ds, 'group', rows);
    },

    aggregate(input, params): VerbResult {
      const ds = resolve(input);
      const groupBy = params.groupBy ?? [];
      for (const b of groupBy) requireSafe(ds.schema, b);
      for (const op of params.ops) {
        if (op.fn !== 'count') {
          if (op.field === undefined) {
            throw new VerbError(`aggregate "${op.fn}" requires a field`);
          }
          requireNumeric(ds.schema, op.field);
        }
      }
      const groups = new Map<string, { key: DatasetRow; rows: DatasetRow[] }>();
      if (groupBy.length === 0) {
        groups.set('*', { key: {}, rows: [...ds.rows] });
      } else {
        for (const r of ds.rows) {
          const k = JSON.stringify(groupBy.map((b) => r[b] ?? null));
          let g = groups.get(k);
          if (g === undefined) {
            g = { key: pick(r, groupBy), rows: [] };
            groups.set(k, g);
          }
          g.rows.push(r);
        }
      }
      const rows: DatasetRow[] = [];
      for (const g of groups.values()) {
        const out: Record<string, unknown> = { ...g.key };
        for (const op of params.ops) out[op.alias] = applyAggregate(op, g.rows);
        rows.push(out);
      }
      return derive(ds, 'aggregate', rows);
    },

    select(input, columns): VerbResult {
      const ds = resolve(input);
      for (const c of columns) field(ds.schema, c);
      return derive(
        ds,
        'select',
        ds.rows.map((r) => pick(r, columns)),
      );
    },

    count(input): VerbResult {
      const ds = resolve(input);
      return derive(ds, 'count', [{ count: ds.rows.length }]);
    },

    join(left, right, on): VerbResult {
      const leftDs = resolve(left);
      const rightDs = resolve(right);
      requireSafe(leftDs.schema, on.left);
      requireSafe(rightDs.schema, on.right);
      const index = new Map<string, DatasetRow[]>();
      for (const r of rightDs.rows) {
        const k = JSON.stringify(r[on.right] ?? null);
        const bucket = index.get(k);
        if (bucket === undefined) index.set(k, [r]);
        else bucket.push(r);
      }
      const rows: DatasetRow[] = [];
      for (const l of leftDs.rows) {
        const matches = index.get(JSON.stringify(l[on.left] ?? null));
        if (matches === undefined) continue;
        for (const r of matches) rows.push({ ...r, ...l });
      }
      return derive(leftDs, 'join', rows);
    },
  };
}
