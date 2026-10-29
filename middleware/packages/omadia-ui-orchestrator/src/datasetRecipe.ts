import type { PrivacyDatasetProvenance } from '@omadia/plugin-api';
import { isRowTool, parseRefreshSource, type RefreshFilter, type RefreshSource } from '@omadia/fast-path';

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
 *   - anything else (sort, top_n, aggregate, join, …) → skipped
 *
 * Only a learnable READ tool (fast-path name classifier) qualifies — a
 * replayed write would be a side effect on every refresh. Pure: no I/O.
 */

export type DerivedRecipe = { ok: true; source: RefreshSource } | { ok: false; reason: string };

const MAX_FILTER_CLAUSES = 4;

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
  const filter: RefreshFilter[] = [];
  for (const step of provenance.verbs) {
    if (step.verb === 'select') continue;
    if (step.verb !== 'filter') return { ok: false, reason: `verb-${step.verb}` };
    const clauses = predicateClauses(step.args['predicate']);
    if (clauses === null) return { ok: false, reason: 'filter-unsupported' };
    filter.push(...clauses);
  }
  if (filter.length > MAX_FILTER_CLAUSES) return { ok: false, reason: 'filter-unsupported' };
  const candidate = {
    tool: provenance.tool,
    input,
    // an envelope origin: replay reads the records from here, not "first array"
    ...(provenance.itemsPath !== undefined ? { itemsPath: provenance.itemsPath } : {}),
    map: Object.fromEntries(columnPaths.map((p) => [p, p])),
    ...(columnPaths.includes('id') ? { rowKey: 'id' } : {}),
    ...(filter.length > 0 ? { filter } : {}),
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
