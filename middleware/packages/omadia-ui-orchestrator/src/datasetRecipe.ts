import type { PrivacyDatasetProvenance } from '@omadia/plugin-api';
import {
  isRowTool,
  parseRefreshSource,
  type RefreshFilter,
  type RefreshSort,
  type RefreshSource,
} from '@omadia/fast-path';

/**
 * Refresh recipes for AGENT-filled tables (datasetId publishes).
 *
 * A fast-path publish carries its recipe; an agent publish by privacy-shield
 * `datasetId` does not — the agent never sees the rows and rarely declares a
 * `source`. The Privacy Shield knows the dataset's provenance (the ONE tool
 * call behind it + the verbs applied since), so the recipe is derived here:
 * replay the same call, map the published column paths onto themselves (a
 * dataset publish keys the table's columns BY path, patchComposition.ts) and
 * re-apply what the verbs did — when a RefreshSource can express it:
 *
 *   - no verbs                → the call as is
 *   - `select`                → nothing to replay: the map IS the projection
 *   - `filter` (eq / and-eq)  → `RefreshSource.filter` clauses
 *   - `sort` / `top_n`        → `RefreshSource.sort` (+ `take` for top_n)
 *   - anything else (aggregate, join, …) → skipped
 *
 * A RefreshSource applies filter → sort → take, so the chain must reduce to
 * that order. Filters and sorts commute (a stable sort keeps a filtered
 * subset's order, a filter keeps a sorted order), and a later stable sort
 * only breaks ties of an earlier one — it becomes the PRIMARY key. A top_n
 * cuts the set, so nothing that reorders or filters may follow it.
 *
 * Only a learnable READ tool (fast-path name classifier) qualifies — a
 * replayed write would be a side effect on every refresh. Pure: no I/O.
 */

export type DerivedRecipe = { ok: true; source: RefreshSource } | { ok: false; reason: string };

const MAX_FILTER_CLAUSES = 4;
const MAX_SORT_CLAUSES = 3;

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** An eq predicate (or an AND of eq predicates) as filter clauses; null = not expressible. */
function predicateClauses(predicate: unknown): RefreshFilter[] | null {
  if (typeof predicate !== 'object' || predicate === null) return null;
  const p = predicate as { op?: unknown; field?: unknown; value?: unknown; clauses?: unknown };
  if (p.op === 'eq') {
    return typeof p.field === 'string' && p.field.length > 0 && isScalar(p.value)
      ? [{ field: p.field, eq: p.value }]
      : null;
  }
  if (p.op === 'and' && Array.isArray(p.clauses) && p.clauses.length > 0) {
    const out: RefreshFilter[] = [];
    for (const clause of p.clauses) {
      const sub = predicateClauses(clause);
      if (sub === null) return null;
      out.push(...sub);
    }
    return out;
  }
  return null;
}

type Direction = RefreshSort['dir'];

/** A verb's `direction` argument; null = invalid. The defaults are the
 *  verbs' own (v4 `sort` asc, `top_n` desc). */
function direction(value: unknown, fallback: Direction): Direction | null {
  if (value === undefined) return fallback;
  return value === 'asc' || value === 'desc' ? value : null;
}

/** `clause` as the new primary key; an older clause on the same field is
 *  fully overridden by it and dropped. */
const withPrimary = (sort: readonly RefreshSort[], clause: RefreshSort): RefreshSort[] => [
  clause,
  ...sort.filter((c) => c.field !== clause.field),
];

/** Post-fetch steps of a verb chain, or why they are not expressible. */
type Steps = { filter: RefreshFilter[]; sort: RefreshSort[]; take?: number } | { reason: string };

function replaySteps(verbs: PrivacyDatasetProvenance['verbs']): Steps {
  const filter: RefreshFilter[] = [];
  let sort: RefreshSort[] = [];
  let take: number | undefined;
  for (const step of verbs) {
    if (step.verb === 'select') continue;
    if (step.verb !== 'filter' && step.verb !== 'sort' && step.verb !== 'top_n') {
      return { reason: `verb-${step.verb}` };
    }
    // the cut is final: a filter / reorder after it is no filter → sort → take
    if (take !== undefined) return { reason: `verb-${step.verb}-after-top_n` };
    if (step.verb === 'filter') {
      const clauses = predicateClauses(step.args['predicate']);
      if (clauses === null) return { reason: 'filter-unsupported' };
      filter.push(...clauses);
      continue;
    }
    const by = step.args['by'];
    const dir = direction(step.args['direction'], step.verb === 'sort' ? 'asc' : 'desc');
    if (typeof by !== 'string' || by.length === 0 || dir === null) return { reason: 'sort-unsupported' };
    sort = withPrimary(sort, { field: by, dir });
    if (step.verb === 'top_n') {
      const n = step.args['n'];
      // n = 0 is an empty table — nothing worth replaying
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return { reason: 'top_n-unsupported' };
      take = n;
    }
  }
  if (filter.length > MAX_FILTER_CLAUSES) return { reason: 'filter-unsupported' };
  if (sort.length > MAX_SORT_CLAUSES) return { reason: 'sort-unsupported' };
  return { filter, sort, ...(take !== undefined ? { take } : {}) };
}

/**
 * Derive the recipe for a dataset published to a table whose columns are
 * `columnPaths` (the publish's `datasetColumns`).
 */
export function deriveDatasetRecipe(
  provenance: PrivacyDatasetProvenance | undefined,
  columnPaths: readonly string[],
): DerivedRecipe {
  if (provenance === undefined) return { ok: false, reason: 'no-provenance' };
  if (!isRowTool(provenance.tool)) return { ok: false, reason: 'tool-not-learnable' };
  const input = provenance.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'input-not-object' };
  }
  if (columnPaths.length === 0) return { ok: false, reason: 'no-columns' };
  const steps = replaySteps(provenance.verbs);
  if ('reason' in steps) return { ok: false, reason: steps.reason };
  const { filter, sort, take } = steps;
  const candidate = {
    tool: provenance.tool,
    input,
    // an envelope origin: replay reads the records from here, not "first array"
    ...(provenance.itemsPath !== undefined ? { itemsPath: provenance.itemsPath } : {}),
    map: Object.fromEntries(columnPaths.map((p) => [p, p])),
    ...(columnPaths.includes('id') ? { rowKey: 'id' } : {}),
    ...(filter.length > 0 ? { filter } : {}),
    ...(sort.length > 0 ? { sort } : {}),
    ...(take !== undefined ? { take } : {}),
  };
  // the same whitelist + size bound an agent-declared recipe passes
  const source = parseRefreshSource(candidate);
  return source ? { ok: true, source } : { ok: false, reason: 'invalid-recipe' };
}

/** Provenance read at publish time (inside the turn), consumed once when the
 *  publish is composed. Bounded: an entry nobody takes (a publish whose
 *  stream was aborted) is evicted oldest-first, never kept for long. */
export interface ProvenanceStash {
  put(datasetId: string, provenance: PrivacyDatasetProvenance | undefined): void;
  take(datasetId: string): PrivacyDatasetProvenance | undefined;
}

export const MAX_STASHED_PROVENANCE = 64;

export function createProvenanceStash(max: number = MAX_STASHED_PROVENANCE): ProvenanceStash {
  const entries = new Map<string, PrivacyDatasetProvenance | undefined>();
  return {
    put(datasetId, provenance) {
      entries.delete(datasetId);
      entries.set(datasetId, provenance);
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    take(datasetId) {
      const p = entries.get(datasetId);
      entries.delete(datasetId);
      return p;
    },
  };
}

/** The published dataset of a structured payload `data`: its id + column paths. */
export function readDatasetPublish(
  data: unknown,
): { containerId: string; datasetId: string; paths: string[] } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as { containerId?: unknown; datasetId?: unknown; datasetColumns?: unknown };
  if (typeof d.containerId !== 'string' || typeof d.datasetId !== 'string') return undefined;
  const cols = Array.isArray(d.datasetColumns) ? (d.datasetColumns as unknown[]) : [];
  const paths = cols
    .map((c) => (typeof c === 'object' && c !== null ? (c as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  return { containerId: d.containerId, datasetId: d.datasetId, paths };
}
