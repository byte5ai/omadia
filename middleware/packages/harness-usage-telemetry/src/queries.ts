/**
 * Read-side aggregations over `token_usage` for the cost dashboard.
 *
 * These take an explicit `Pool` (the shared graph pool, fetched from
 * `ctx.services` by the HTTP route) rather than reaching into the recorder
 * singleton — keeping the write path (fire-and-forget) and the read path
 * (request-scoped query) cleanly separated.
 *
 * All amounts are USD; token counts are summed across the window. `since`/
 * `until` are ISO timestamps; omit for "all time".
 *
 * #1396 — time buckets are cut in an explicit IANA zone (`timeZone`, default
 * UTC), never in the Postgres session zone, and `since` is floored to the start
 * of its bucket in that zone so the first bar is a whole hour/day.
 */
import type { Pool } from 'pg';

export interface UsageWindow {
  readonly since?: string | undefined;
  readonly until?: string | undefined;
}

export interface UsageTotals {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** BILLED money only. A subscription row contributes 0 (OM-103). */
  readonly costUsd: number;
  /**
   * OM-103 — what the subscription turns in this window would have cost on
   * the metered API. Never added to {@link costUsd}: nobody paid it.
   */
  readonly referenceCostUsd: number;
  /**
   * OM-103 — how many of {@link calls} ran through the subscription CLI. The
   * dashboard used to read "0 Calls" after a dozen subscription turns, which
   * was indistinguishable from "the telemetry is broken".
   */
  readonly subscriptionCalls: number;
  /** cacheRead / (cacheRead + input), 0..1 — how much input was served warm. */
  readonly cacheHitRatio: number;
}

export interface UsageByKey {
  readonly key: string;
  readonly calls: number;
  readonly costUsd: number;
  /** OM-103 — informational subscription cost for this key; see UsageTotals. */
  readonly referenceCostUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /**
   * #1393 — cache writes, often the largest part of a row's cost. Without them
   * a row's tokens could not explain its price.
   */
  readonly cacheCreationTokens: number;
  /**
   * #1393 — set when this row folds several raw `source` values together:
   * `'builder'` for every `sub-agent builder-<draftId>`, `'other'` for the tail
   * past {@link BY_SOURCE_LIMIT}. Absent on an ordinary row.
   */
  readonly group?: UsageKeyGroup | undefined;
  /** #1393 — how many raw keys a grouped row folds; absent when ungrouped. */
  readonly members?: number | undefined;
}

export type UsageKeyGroup = 'builder' | 'other';

export interface UsageBucket {
  /** Bucket start as an ISO instant (local midnight / hour start in the zone). */
  readonly bucket: string;
  readonly costUsd: number;
  readonly calls: number;
}

export type UsageBucketSize = 'hour' | 'day';

/**
 * #1393 — the builder names its sub-agent `builder-<draftId>`, so every draft
 * became its own "By source" row. They fold into one row under this key.
 */
export const BUILDER_SOURCE_PREFIX = 'sub-agent builder-';
export const BUILDER_SOURCE_KEY = 'sub-agent builder';
/** Key of the row the "By source" tail folds into. */
export const OTHER_SOURCE_KEY = 'other';
/** #1393 — "By source" shows this many rows, then one "Other" row. */
export const BY_SOURCE_LIMIT = 10;

export interface UsageDashboard {
  readonly totals: UsageTotals;
  readonly byModel: readonly UsageByKey[];
  readonly bySource: readonly UsageByKey[];
  readonly timeSeries: readonly UsageBucket[];
}

/**
 * OM-103 — the exact `source` values the subscription seams record under: the
 * CLI-owned chat turn and the Shape-2 completion.
 *
 * An exhaustive list rather than a `claude-cli%` prefix match, because
 * `withProviderUsageTracking` takes a caller-supplied `source`: a future
 * provider named `claude-cli-something-metered` would be folded into the
 * subscription count by a prefix and never noticed. Interpolated into SQL
 * rather than parameterised because these are module constants that never see
 * caller input; the window bounds stay parameterised.
 */
export const SUBSCRIPTION_SOURCES = ['claude-cli', 'claude-cli-completion'] as const;
const SUBSCRIPTION_SOURCE_LIST = SUBSCRIPTION_SOURCES.map((s) => `'${s}'`).join(',');

/**
 * How the dashboard cuts time: bucket size plus the zone the buckets are cut
 * in. `bucket` is interpolated into SQL, so it is typed to the two literals;
 * the zone is always a bind parameter.
 */
interface Bucketing {
  readonly bucket: UsageBucketSize;
  readonly timeZone: string;
}

function windowClause(w: UsageWindow, params: unknown[], bucketing?: Bucketing): string {
  const clauses: string[] = [];
  if (w.since) {
    params.push(w.since);
    const since = `$${params.length}::timestamptz`;
    if (bucketing) {
      // #1396 — floor to the bucket start in the operator's zone, so the
      // first bar covers a whole day (or hour) and the KPI totals cover
      // exactly the span the chart shows.
      params.push(bucketing.timeZone);
      const tz = `$${params.length}::text`;
      clauses.push(
        `created_at >= (date_trunc('${bucketing.bucket}', ${since} AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`,
      );
    } else {
      clauses.push(`created_at >= ${since}`);
    }
  }
  if (w.until) {
    params.push(w.until);
    clauses.push(`created_at <= $${params.length}`);
  }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

async function fetchTotals(pool: Pool, w: UsageWindow, b: Bucketing): Promise<UsageTotals> {
  const params: unknown[] = [];
  const where = windowClause(w, params, b);
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)                          AS calls,
       COALESCE(SUM(input_tokens),0)     AS input_tokens,
       COALESCE(SUM(output_tokens),0)    AS output_tokens,
       COALESCE(SUM(cache_read_tokens),0)     AS cache_read_tokens,
       COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
       COALESCE(SUM(cost_usd),0)         AS cost_usd,
       COALESCE(SUM(reference_cost_usd),0) AS reference_cost_usd,
       COUNT(*) FILTER (WHERE source IN (${SUBSCRIPTION_SOURCE_LIST})) AS subscription_calls
     FROM token_usage ${where}`,
    params,
  );
  const r = rows[0] ?? {};
  const inputTokens = num(r.input_tokens);
  const cacheReadTokens = num(r.cache_read_tokens);
  const warmDenom = inputTokens + cacheReadTokens;
  return {
    calls: num(r.calls),
    inputTokens,
    outputTokens: num(r.output_tokens),
    cacheReadTokens,
    cacheCreationTokens: num(r.cache_creation_tokens),
    costUsd: num(r.cost_usd),
    referenceCostUsd: num(r.reference_cost_usd),
    subscriptionCalls: num(r.subscription_calls),
    cacheHitRatio: warmDenom > 0 ? cacheReadTokens / warmDenom : 0,
  };
}

function byKeyRow(r: Record<string, unknown>): UsageByKey {
  return {
    key: String(r.key ?? 'unknown'),
    calls: num(r.calls),
    costUsd: num(r.cost_usd),
    referenceCostUsd: num(r.reference_cost_usd),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheCreationTokens: num(r.cache_creation_tokens),
  };
}

async function fetchByKey(
  pool: Pool,
  column: 'model' | 'source',
  w: UsageWindow,
  b: Bucketing,
): Promise<UsageByKey[]> {
  const params: unknown[] = [];
  const where = windowClause(w, params, b);
  // #1393 — every builder draft is its own `source`; fold them into one key.
  // The prefix is a module constant without LIKE wildcards, so interpolating
  // it is safe; `members` counts the distinct raw sources a row folds.
  const keyExpr =
    column === 'source'
      ? `CASE WHEN source LIKE '${BUILDER_SOURCE_PREFIX}%' THEN '${BUILDER_SOURCE_KEY}' ELSE source END`
      : 'model';
  const membersExpr = column === 'source' ? 'COUNT(DISTINCT source)' : '1';
  const { rows } = await pool.query(
    `SELECT
       ${keyExpr}                         AS key,
       ${membersExpr}                     AS members,
       COUNT(*)                           AS calls,
       COALESCE(SUM(cost_usd),0)          AS cost_usd,
       COALESCE(SUM(reference_cost_usd),0) AS reference_cost_usd,
       COALESCE(SUM(input_tokens),0)      AS input_tokens,
       COALESCE(SUM(output_tokens),0)     AS output_tokens,
       COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
       COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens
     FROM token_usage ${where}
     GROUP BY 1
     ORDER BY cost_usd DESC, reference_cost_usd DESC, calls DESC, key ASC`,
    params,
  );
  return rows.map((r: Record<string, unknown>) =>
    column === 'source' && r.key === BUILDER_SOURCE_KEY
      ? { ...byKeyRow(r), group: 'builder' as const, members: num(r.members) }
      : byKeyRow(r),
  );
}

/**
 * #1393 — keeps "By source" readable: the top {@link BY_SOURCE_LIMIT} rows by
 * cost, then one `other` row summing the rest. A tail of a single row is shown
 * as itself — an "Other" that hides exactly one key explains nothing.
 */
export function capByKey(rows: readonly UsageByKey[], limit: number = BY_SOURCE_LIMIT): UsageByKey[] {
  if (rows.length <= limit + 1) return [...rows];
  const tail = rows.slice(limit);
  const sum = (pick: (r: UsageByKey) => number): number =>
    tail.reduce((acc, r) => acc + pick(r), 0);
  const other: UsageByKey = {
    key: OTHER_SOURCE_KEY,
    group: 'other',
    // Sources, not drafts: a folded builder row is one source here.
    members: tail.length,
    calls: sum((r) => r.calls),
    costUsd: sum((r) => r.costUsd),
    referenceCostUsd: sum((r) => r.referenceCostUsd),
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    cacheReadTokens: sum((r) => r.cacheReadTokens),
    cacheCreationTokens: sum((r) => r.cacheCreationTokens),
  };
  return [...rows.slice(0, limit), other];
}

/**
 * Cost per bucket, gaps included (#1388): every bucket from the window start
 * (or the first row, for "all time") to the bucket holding `until`/now gets a
 * row, idle ones with zero, so the bars line up with time. Buckets are cut in
 * `timeZone` (#1396): `created_at AT TIME ZONE tz` is local wall time, and the
 * outer `AT TIME ZONE tz` turns the local bucket start back into an instant.
 *
 * DST: the wall-clock hour a spring-forward skips maps to the same instant as
 * the next one, so the result is grouped by instant — one row per bucket key.
 * On a fall-back the repeated local hour is one bucket covering two real hours.
 */
async function fetchTimeSeries(
  pool: Pool,
  w: UsageWindow,
  b: Bucketing,
): Promise<UsageBucket[]> {
  const params: unknown[] = [];
  const where = windowClause(w, params, b);
  params.push(b.timeZone);
  const tz = `$${params.length}::text`;
  const lo = w.since
    ? (() => {
        params.push(w.since);
        return `date_trunc('${b.bucket}', $${params.length}::timestamptz AT TIME ZONE ${tz})`;
      })()
    : '(SELECT MIN(local_bucket) FROM used)';
  params.push(w.until ?? null);
  const hi = `date_trunc('${b.bucket}', COALESCE($${params.length}::timestamptz, NOW()) AT TIME ZONE ${tz})`;
  const { rows } = await pool.query(
    `WITH used AS (
       SELECT
         date_trunc('${b.bucket}', created_at AT TIME ZONE ${tz}) AS local_bucket,
         COALESCE(SUM(cost_usd),0) AS cost_usd,
         COUNT(*)                  AS calls
       FROM token_usage ${where}
       GROUP BY 1
     )
     SELECT
       series.local_bucket AT TIME ZONE ${tz} AS bucket,
       COALESCE(SUM(used.cost_usd), 0)       AS cost_usd,
       COALESCE(SUM(used.calls), 0)          AS calls
     FROM generate_series(${lo}, ${hi}, interval '1 ${b.bucket}') AS series(local_bucket)
     LEFT JOIN used ON used.local_bucket = series.local_bucket
     GROUP BY 1
     ORDER BY 1 ASC`,
    params,
  );
  return rows.map((r: Record<string, unknown>) => ({
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
    costUsd: num(r.cost_usd),
    calls: num(r.calls),
  }));
}

/**
 * Builds the full dashboard payload in one pass: totals, per-model and
 * per-source breakdowns, and a cost time series. `bucket` controls time-series
 * granularity (default 'hour'); `timeZone` is the IANA zone buckets are cut in
 * (default 'UTC'). The caller validates the zone; it only ever reaches SQL as
 * a bind parameter.
 */
export async function getUsageDashboard(
  pool: Pool,
  w: UsageWindow = {},
  bucket: UsageBucketSize = 'hour',
  timeZone = 'UTC',
): Promise<UsageDashboard> {
  const b: Bucketing = { bucket, timeZone };
  const [totals, byModel, bySource, timeSeries] = await Promise.all([
    fetchTotals(pool, w, b),
    fetchByKey(pool, 'model', w, b),
    fetchByKey(pool, 'source', w, b),
    fetchTimeSeries(pool, w, b),
  ]);
  return { totals, byModel, bySource: capByKey(bySource), timeSeries };
}
