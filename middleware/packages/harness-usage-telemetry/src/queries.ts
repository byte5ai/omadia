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
  readonly costUsd: number;
  /** cacheRead / (cacheRead + input), 0..1 — how much input was served warm. */
  readonly cacheHitRatio: number;
}

export interface UsageByKey {
  readonly key: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}

export interface UsageBucket {
  readonly bucket: string;
  readonly costUsd: number;
  readonly calls: number;
}

export interface UsageDashboard {
  readonly totals: UsageTotals;
  readonly byModel: readonly UsageByKey[];
  readonly bySource: readonly UsageByKey[];
  readonly timeSeries: readonly UsageBucket[];
}

function windowClause(w: UsageWindow, params: unknown[]): string {
  const clauses: string[] = [];
  if (w.since) {
    params.push(w.since);
    clauses.push(`created_at >= $${params.length}`);
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

async function fetchTotals(pool: Pool, w: UsageWindow): Promise<UsageTotals> {
  const params: unknown[] = [];
  const where = windowClause(w, params);
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)                          AS calls,
       COALESCE(SUM(input_tokens),0)     AS input_tokens,
       COALESCE(SUM(output_tokens),0)    AS output_tokens,
       COALESCE(SUM(cache_read_tokens),0)     AS cache_read_tokens,
       COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
       COALESCE(SUM(cost_usd),0)         AS cost_usd
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
    cacheHitRatio: warmDenom > 0 ? cacheReadTokens / warmDenom : 0,
  };
}

async function fetchByKey(
  pool: Pool,
  column: 'model' | 'source',
  w: UsageWindow,
): Promise<UsageByKey[]> {
  const params: unknown[] = [];
  const where = windowClause(w, params);
  const { rows } = await pool.query(
    `SELECT
       ${column}                          AS key,
       COUNT(*)                           AS calls,
       COALESCE(SUM(cost_usd),0)          AS cost_usd,
       COALESCE(SUM(input_tokens),0)      AS input_tokens,
       COALESCE(SUM(output_tokens),0)     AS output_tokens,
       COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens
     FROM token_usage ${where}
     GROUP BY ${column}
     ORDER BY cost_usd DESC`,
    params,
  );
  return rows.map((r) => ({
    key: String(r.key ?? 'unknown'),
    calls: num(r.calls),
    costUsd: num(r.cost_usd),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
  }));
}

async function fetchTimeSeries(
  pool: Pool,
  w: UsageWindow,
  bucket: 'hour' | 'day',
): Promise<UsageBucket[]> {
  const params: unknown[] = [];
  const where = windowClause(w, params);
  const { rows } = await pool.query(
    `SELECT
       date_trunc('${bucket}', created_at) AS bucket,
       COALESCE(SUM(cost_usd),0)           AS cost_usd,
       COUNT(*)                            AS calls
     FROM token_usage ${where}
     GROUP BY bucket
     ORDER BY bucket ASC`,
    params,
  );
  return rows.map((r) => ({
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
    costUsd: num(r.cost_usd),
    calls: num(r.calls),
  }));
}

/**
 * Builds the full dashboard payload in one pass: totals, per-model and
 * per-source breakdowns, and a cost time series. `bucket` controls time-series
 * granularity (default 'hour').
 */
export async function getUsageDashboard(
  pool: Pool,
  w: UsageWindow = {},
  bucket: 'hour' | 'day' = 'hour',
): Promise<UsageDashboard> {
  const [totals, byModel, bySource, timeSeries] = await Promise.all([
    fetchTotals(pool, w),
    fetchByKey(pool, 'model', w),
    fetchByKey(pool, 'source', w),
    fetchTimeSeries(pool, w, bucket),
  ]);
  return { totals, byModel, bySource, timeSeries };
}
