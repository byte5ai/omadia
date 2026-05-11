import type { Pool } from 'pg';

/**
 * @omadia/knowledge-graph-neon — GC quota sweep (palaia Phase 4 /
 * OB-73, Slice C).
 *
 * Daily housekeeping that enforces per-scope hard-limits on the Turn
 * volume:
 *
 *   1. **Count quota** — if a scope holds more than `hotMaxEntries` Turns,
 *      evict the bottom-(count − hotMaxEntries) by retention-priority.
 *   2. **Char quota** — if the cumulative `userMessage + assistantAnswer`
 *      character count exceeds `maxTotalChars`, evict the bottom rows
 *      until the sum drops at-or-below the cap.
 *
 * Retention-priority = `type_weight × decay_score`, ascending. Higher
 * type-weights survive longer; defaults are `process=2.0, task=1.5,
 * memory=1.0` (palaia ADR-004 — `process` and `task` rows hold operational
 * value, generic `memory` rows churn). Within the same type, low
 * decay-score (cold + ungenutzt) goes first.
 *
 * The done-task-TTL is intentionally NOT part of this sweep — that lives
 * in `runDecaySweep` (hourly) so resolved tasks vanish quickly without
 * waiting for the daily quota tick.
 *
 * Single-flight is enforced by the caller (`ctx.jobs.register({overlap:
 * 'skip'})`); we don't track local state.
 */

export interface TypeWeights {
  /** Default: 1.0 (baseline). */
  memory: number;
  /** Default: 2.0 — process knowledge survives longest. */
  process: number;
  /** Default: 1.5. */
  task: number;
}

export interface GcSweepOptions {
  pool: Pool;
  tenantId: string;
  /** Per-scope ceiling on Turn count. Scopes above this lose the lowest-
   *  priority excess rows on the next sweep. */
  hotMaxEntries: number;
  /** Per-scope ceiling on combined `userMessage + assistantAnswer` chars.
   *  Scopes above this lose rows until the sum drops at-or-below. */
  maxTotalChars: number;
  /** Retention-priority weights — higher = survives longer. */
  typeWeights: TypeWeights;
  log?: (msg: string) => void;
}

export interface GcSweepStats {
  /** Distinct scopes that needed eviction (any quota). */
  scopesAffected: number;
  /** Rows evicted by the count quota. */
  evictedByCount: number;
  /** Rows evicted by the char quota. */
  evictedByChars: number;
  durationMs: number;
}

interface ScopeOverflow {
  scope: string;
  turnCount: number;
  totalChars: number;
}

/** Single SQL pass to identify scopes that violate at least one quota. */
async function findOverflowingScopes(
  pool: Pool,
  tenantId: string,
  hotMaxEntries: number,
  maxTotalChars: number,
): Promise<ScopeOverflow[]> {
  const result = await pool.query<{
    scope: string;
    turn_count: string;
    total_chars: string;
  }>(
    `
    SELECT
      scope,
      COUNT(*)::text                                                  AS turn_count,
      COALESCE(SUM(
        LENGTH(COALESCE(properties->>'userMessage', '')) +
        LENGTH(COALESCE(properties->>'assistantAnswer', ''))
      ), 0)::text                                                     AS total_chars
    FROM graph_nodes
    WHERE tenant_id = $1
      AND type = 'Turn'
      AND scope IS NOT NULL
    GROUP BY scope
    HAVING COUNT(*) > $2 OR COALESCE(SUM(
        LENGTH(COALESCE(properties->>'userMessage', '')) +
        LENGTH(COALESCE(properties->>'assistantAnswer', ''))
      ), 0) > $3
    `,
    [tenantId, hotMaxEntries, maxTotalChars],
  );
  return result.rows.map((r) => ({
    scope: r.scope,
    turnCount: Number(r.turn_count),
    totalChars: Number(r.total_chars),
  }));
}

/**
 * Evict the lowest-priority Turns from a single scope until the count
 * drops to `hotMaxEntries` or below. Returns the number of rows actually
 * deleted (may differ from the requested limit if rows were already gone).
 */
async function evictByCount(
  pool: Pool,
  tenantId: string,
  scope: string,
  excess: number,
  weights: TypeWeights,
): Promise<number> {
  if (excess <= 0) return 0;
  const result = await pool.query(
    `
    DELETE FROM graph_nodes
    WHERE id IN (
      SELECT id FROM graph_nodes
       WHERE tenant_id = $1
         AND type = 'Turn'
         AND scope = $2
       ORDER BY (
         CASE entry_type
           WHEN 'process' THEN $3::real
           WHEN 'task'    THEN $4::real
           ELSE                $5::real
         END
       ) * decay_score ASC,
       created_at ASC
       LIMIT $6
    )
    `,
    [tenantId, scope, weights.process, weights.task, weights.memory, excess],
  );
  return result.rowCount ?? 0;
}

/**
 * Evict from a scope while its char-sum is above `maxTotalChars`. We
 * compute the target deletion count up front by chasing the cumulative
 * sum from the bottom of the priority order — single SQL, no row-by-row
 * loop in JS.
 */
async function evictByChars(
  pool: Pool,
  tenantId: string,
  scope: string,
  maxTotalChars: number,
  weights: TypeWeights,
): Promise<number> {
  // Window function picks rows in eviction order (lowest priority first)
  // and computes the cumulative chars-saved if we deleted up to and
  // including each one. Rows whose `cumulative_chars_after_delete` would
  // bring `current_total - cumulative` ≤ maxTotalChars are dropped.
  const result = await pool.query(
    `
    WITH ranked AS (
      SELECT
        id,
        LENGTH(COALESCE(properties->>'userMessage', '')) +
        LENGTH(COALESCE(properties->>'assistantAnswer', '')) AS chars,
        SUM(
          LENGTH(COALESCE(properties->>'userMessage', '')) +
          LENGTH(COALESCE(properties->>'assistantAnswer', ''))
        ) OVER (
          ORDER BY (
            CASE entry_type
              WHEN 'process' THEN $3::real
              WHEN 'task'    THEN $4::real
              ELSE                $5::real
            END
          ) * decay_score ASC,
          created_at ASC
        ) AS cum_chars,
        SUM(
          LENGTH(COALESCE(properties->>'userMessage', '')) +
          LENGTH(COALESCE(properties->>'assistantAnswer', ''))
        ) OVER () AS total_chars
      FROM graph_nodes
      WHERE tenant_id = $1
        AND type = 'Turn'
        AND scope = $2
    )
    DELETE FROM graph_nodes
    WHERE id IN (
      SELECT id FROM ranked
       WHERE total_chars - (cum_chars - chars) > $6::int
    )
    `,
    [
      tenantId,
      scope,
      weights.process,
      weights.task,
      weights.memory,
      maxTotalChars,
    ],
  );
  return result.rowCount ?? 0;
}

/**
 * Run the daily GC sweep. Per scope: enforce count quota first (drops
 * the cheapest extras), then re-check char quota (might already be
 * satisfied after the count pass). Order matters — count is a hard
 * cap, char is a soft size-bound.
 */
export async function runGcSweep(opts: GcSweepOptions): Promise<GcSweepStats> {
  const log = opts.log ?? ((msg: string): void => { console.error(msg); });
  const startedAt = Date.now();

  const overflowing = await findOverflowingScopes(
    opts.pool,
    opts.tenantId,
    opts.hotMaxEntries,
    opts.maxTotalChars,
  );

  if (overflowing.length === 0) {
    log('[graph-gc] sweep done — no scope over quota');
    return {
      scopesAffected: 0,
      evictedByCount: 0,
      evictedByChars: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  let evictedByCount = 0;
  let evictedByChars = 0;
  let scopesAffected = 0;

  for (const overflow of overflowing) {
    let scopeTouched = false;
    if (overflow.turnCount > opts.hotMaxEntries) {
      const evicted = await evictByCount(
        opts.pool,
        opts.tenantId,
        overflow.scope,
        overflow.turnCount - opts.hotMaxEntries,
        opts.typeWeights,
      );
      evictedByCount += evicted;
      if (evicted > 0) scopeTouched = true;
    }

    if (overflow.totalChars > opts.maxTotalChars) {
      const evicted = await evictByChars(
        opts.pool,
        opts.tenantId,
        overflow.scope,
        opts.maxTotalChars,
        opts.typeWeights,
      );
      evictedByChars += evicted;
      if (evicted > 0) scopeTouched = true;
    }

    if (scopeTouched) scopesAffected += 1;
  }

  const durationMs = Date.now() - startedAt;
  log(
    `[graph-gc] sweep done scopes=${String(scopesAffected)} evicted-count=${String(evictedByCount)} evicted-chars=${String(evictedByChars)} (${String(durationMs)}ms)`,
  );

  return {
    scopesAffected,
    evictedByCount,
    evictedByChars,
    durationMs,
  };
}
