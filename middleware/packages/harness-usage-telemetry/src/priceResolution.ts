/**
 * #1389 — "price unknown", resolved at read time. No schema change.
 *
 * A metered call whose model has no price entry is recorded at `cost_usd = 0`.
 * Summed as-is, that zero reads as "free". The dashboard therefore looks at
 * every metered $0 row with tokens when it reads the ledger:
 *  - its model still has no price → it is "price unknown": counted on the
 *    totals and on its By model / By source rows, and left out of every cost
 *    figure (it contributes nothing there anyway);
 *  - its model has a price now → it is priced from its tokens with today's
 *    table, so a price added later corrects the old rows without a backfill.
 *
 * Subscription rows are not in scope: they bill $0 by design (OM-103).
 */
import { computeCostUsd, hasKnownPrice } from './pricing.js';

/** Metered $0 rows with tokens, counted per model and By-source key. */
export interface ZeroCostGroup {
  readonly model: string;
  readonly sourceKey: string;
  readonly calls: number;
}

/** One metered $0 row of a model that has a price now. */
export interface ZeroCostCall {
  readonly model: string;
  readonly sourceKey: string;
  /** Bucket start as an ISO instant, cut like the time series. */
  readonly bucket: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/** The parts of a breakdown row this module reads and adjusts. */
interface KeyedRow {
  readonly key: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly referenceCostUsd: number;
  readonly unpricedCalls?: number | undefined;
}

interface CostedBucket {
  readonly bucket: string;
  readonly costUsd: number;
}

export interface PriceResolutionInput<R extends KeyedRow, B extends CostedBucket> {
  readonly totalsCostUsd: number;
  readonly byModel: readonly R[];
  readonly bySource: readonly R[];
  readonly timeSeries: readonly B[];
}

export interface PriceResolution<R extends KeyedRow, B extends CostedBucket> {
  readonly totalsCostUsd: number;
  readonly unpricedCalls: number;
  /** Model ids without a price, sorted. */
  readonly unpricedModels: readonly string[];
  readonly byModel: R[];
  readonly bySource: R[];
  readonly timeSeries: B[];
}

/** A probe that bills on any non-zero price, base or long-context tier. */
const PRICE_PROBE = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Models among the $0 groups that have a non-zero price now — their rows get
 * priced. A model priced at an explicit $0 (a local model) is known but has
 * nothing to add, so its rows are not fetched.
 */
export function modelsToReprice(groups: readonly ZeroCostGroup[]): string[] {
  return [...new Set(groups.map((g) => g.model))]
    .filter((m) => hasKnownPrice(m) && computeCostUsd(m, PRICE_PROBE) > 0)
    .sort();
}

/** Same order as the SQL: cost, reference cost, calls, key. */
function byCost(a: KeyedRow, b: KeyedRow): number {
  return (
    b.costUsd - a.costUsd ||
    b.referenceCostUsd - a.referenceCostUsd ||
    b.calls - a.calls ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

function addTo(map: Map<string, number>, key: string, n: number): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

function adjustRows<R extends KeyedRow>(
  rows: readonly R[],
  addedCost: ReadonlyMap<string, number>,
  unpriced: ReadonlyMap<string, number>,
): R[] {
  const out = rows.map((r) => {
    const cost = addedCost.get(r.key) ?? 0;
    const calls = unpriced.get(r.key) ?? 0;
    if (cost === 0 && calls === 0) return r;
    return {
      ...r,
      costUsd: r.costUsd + cost,
      ...(calls > 0 ? { unpricedCalls: calls } : {}),
    };
  });
  // Re-sort only when a cost moved: a no-op keeps the database's order.
  return addedCost.size > 0 ? out.sort(byCost) : out;
}

export function resolvePrices<R extends KeyedRow, B extends CostedBucket>(
  input: PriceResolutionInput<R, B>,
  groups: readonly ZeroCostGroup[],
  calls: readonly ZeroCostCall[],
): PriceResolution<R, B> {
  const unpricedByModel = new Map<string, number>();
  const unpricedBySource = new Map<string, number>();
  for (const g of groups) {
    if (hasKnownPrice(g.model)) continue;
    addTo(unpricedByModel, g.model, g.calls);
    addTo(unpricedBySource, g.sourceKey, g.calls);
  }

  const costByModel = new Map<string, number>();
  const costBySource = new Map<string, number>();
  const costByBucket = new Map<number, number>();
  let addedTotal = 0;
  for (const c of calls) {
    if (!hasKnownPrice(c.model)) continue;
    const cost = computeCostUsd(c.model, c);
    if (cost === 0) continue;
    addedTotal += cost;
    addTo(costByModel, c.model, cost);
    addTo(costBySource, c.sourceKey, cost);
    const t = Date.parse(c.bucket);
    costByBucket.set(t, (costByBucket.get(t) ?? 0) + cost);
  }

  let unpricedCalls = 0;
  for (const n of unpricedByModel.values()) unpricedCalls += n;

  return {
    totalsCostUsd: input.totalsCostUsd + addedTotal,
    unpricedCalls,
    unpricedModels: [...unpricedByModel.keys()].sort(),
    byModel: adjustRows(input.byModel, costByModel, unpricedByModel),
    bySource: adjustRows(input.bySource, costBySource, unpricedBySource),
    timeSeries: input.timeSeries.map((b) => {
      const cost = costByBucket.get(Date.parse(b.bucket)) ?? 0;
      return cost === 0 ? b : { ...b, costUsd: b.costUsd + cost };
    }),
  };
}
