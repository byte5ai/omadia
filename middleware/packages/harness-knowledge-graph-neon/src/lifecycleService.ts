import type { Pool } from 'pg';

import { runDecaySweep, type DecaySweepStats } from './decayJob.js';
import { runGcSweep, type GcSweepStats, type TypeWeights } from './gc.js';
import type {
  AccessTracker,
  AccessTrackerFlushStats,
} from './accessTracker.js';

/**
 * @omadia/knowledge-graph-neon — LifecycleService (palaia Phase 4 /
 * OB-73, Slice D).
 *
 * Service capability published as `graphLifecycle@1` so kernel-side admin
 * routes (`/api/dev/graph/lifecycle/*`) can render the Tier-Histogram and
 * trigger sweeps without re-reading the plugin's setup-fields. Holds the
 * bound configuration the plugin's `activate()` resolved at startup.
 *
 * Manual triggers (`runDecayNow`, `runGcNow`) bypass the cron-scheduled
 * job; they're useful for operator dry-runs after a quota tweak. The
 * scheduled job stays armed and fires independently — there's no
 * cross-talk.
 */

export interface LifecycleStats {
  /** Total Turn rows for this tenant, regardless of tier. */
  totalTurns: number;
  /** Per-tier count for `type='Turn'`. */
  byTier: { HOT: number; WARM: number; COLD: number };
  /** Per-entry-type count for `type='Turn'`. */
  byEntryType: { memory: number; process: number; task: number };
  /** Buckets of `decay_score`. */
  decayDistribution: {
    /** 0.8–1.0 — fresh / recently-accessed. */
    high: number;
    /** 0.5–0.8 */
    upperMid: number;
    /** 0.2–0.5 */
    lowerMid: number;
    /** 0.0–0.2 — strong eviction candidates. */
    cold: number;
  };
  /** Top scopes by Turn count (descending), capped at 10. */
  topScopesByCount: Array<{ scope: string; count: number; chars: number }>;
  /** OB-74 (Phase 5 / Track-B) — bound GC-Hard-Limits damit der UI Quota-
   *  Indicator (count/chars per scope) farbcodiert anzeigen kann. */
  quotas: {
    hotMaxEntries: number;
    maxTotalChars: number;
  };
}

export interface LastSweep<T> {
  at: string; // ISO
  stats: T;
}

export interface LifecycleService {
  getStats(): Promise<LifecycleStats>;
  runDecayNow(): Promise<DecaySweepStats>;
  runGcNow(): Promise<GcSweepStats>;
  runAccessFlushNow(): Promise<AccessTrackerFlushStats>;
  /** Snapshot of the most recent scheduled or manual sweep, or null
   *  if none has run yet in this process. */
  lastDecay(): LastSweep<DecaySweepStats> | null;
  lastGc(): LastSweep<GcSweepStats> | null;
  lastAccessFlush(): LastSweep<AccessTrackerFlushStats> | null;
}

export interface LifecycleServiceConfig {
  decay: {
    enabled: boolean;
    intervalMinutes: number;
    lambda: number;
    hotToWarmScoreThreshold: number;
    hotToWarmIdleDays: number;
    warmToColdScoreThreshold: number;
    warmToColdIdleDays: number;
    doneTaskTtlHours: number;
  };
  gc: {
    enabled: boolean;
    cron: string;
    intervalMinutes: number | null;
    hotMaxEntries: number;
    maxTotalChars: number;
    typeWeights: TypeWeights;
  };
}

export interface LifecycleServiceDeps {
  pool: Pool;
  tenantId: string;
  config: LifecycleServiceConfig;
  accessTracker: AccessTracker;
  log?: (msg: string) => void;
}

export function createLifecycleService(
  deps: LifecycleServiceDeps,
): LifecycleService {
  const log = deps.log ?? ((msg: string): void => { console.error(msg); });
  let lastDecaySweep: LastSweep<DecaySweepStats> | null = null;
  let lastGcSweep: LastSweep<GcSweepStats> | null = null;
  let lastAccessFlush: LastSweep<AccessTrackerFlushStats> | null = null;

  return {
    /** Expose `config` so the admin UI can render the bound thresholds. */
    get config(): LifecycleServiceConfig {
      return deps.config;
    },

    async getStats(): Promise<LifecycleStats> {
      // One round-trip with three CTEs — Neon doesn't love multiple
      // sequential queries from a stateless route handler.
      const result = await deps.pool.query<{
        total_turns: string;
        hot: string;
        warm: string;
        cold: string;
        memory: string;
        process: string;
        task: string;
        decay_high: string;
        decay_upper_mid: string;
        decay_lower_mid: string;
        decay_cold: string;
      }>(
        `
        WITH base AS (
          SELECT tier, entry_type, decay_score
            FROM graph_nodes
           WHERE tenant_id = $1 AND type = 'Turn'
        )
        SELECT
          COUNT(*)::text                                                AS total_turns,
          SUM(CASE WHEN tier = 'HOT'  THEN 1 ELSE 0 END)::text          AS hot,
          SUM(CASE WHEN tier = 'WARM' THEN 1 ELSE 0 END)::text          AS warm,
          SUM(CASE WHEN tier = 'COLD' THEN 1 ELSE 0 END)::text          AS cold,
          SUM(CASE WHEN entry_type = 'memory'  THEN 1 ELSE 0 END)::text AS memory,
          SUM(CASE WHEN entry_type = 'process' THEN 1 ELSE 0 END)::text AS process,
          SUM(CASE WHEN entry_type = 'task'    THEN 1 ELSE 0 END)::text AS task,
          SUM(CASE WHEN decay_score >= 0.8                       THEN 1 ELSE 0 END)::text AS decay_high,
          SUM(CASE WHEN decay_score >= 0.5 AND decay_score < 0.8 THEN 1 ELSE 0 END)::text AS decay_upper_mid,
          SUM(CASE WHEN decay_score >= 0.2 AND decay_score < 0.5 THEN 1 ELSE 0 END)::text AS decay_lower_mid,
          SUM(CASE WHEN decay_score <  0.2                       THEN 1 ELSE 0 END)::text AS decay_cold
        FROM base
        `,
        [deps.tenantId],
      );

      const r = result.rows[0];
      const totalTurns = Number(r?.total_turns ?? '0');

      const scopesResult = await deps.pool.query<{
        scope: string;
        count: string;
        chars: string;
      }>(
        `
        SELECT
          scope,
          COUNT(*)::text                                      AS count,
          COALESCE(SUM(
            LENGTH(COALESCE(properties->>'userMessage', '')) +
            LENGTH(COALESCE(properties->>'assistantAnswer', ''))
          ), 0)::text                                         AS chars
        FROM graph_nodes
        WHERE tenant_id = $1 AND type = 'Turn' AND scope IS NOT NULL
        GROUP BY scope
        ORDER BY COUNT(*) DESC
        LIMIT 10
        `,
        [deps.tenantId],
      );

      return {
        totalTurns,
        byTier: {
          HOT: Number(r?.hot ?? '0'),
          WARM: Number(r?.warm ?? '0'),
          COLD: Number(r?.cold ?? '0'),
        },
        byEntryType: {
          memory: Number(r?.memory ?? '0'),
          process: Number(r?.process ?? '0'),
          task: Number(r?.task ?? '0'),
        },
        decayDistribution: {
          high: Number(r?.decay_high ?? '0'),
          upperMid: Number(r?.decay_upper_mid ?? '0'),
          lowerMid: Number(r?.decay_lower_mid ?? '0'),
          cold: Number(r?.decay_cold ?? '0'),
        },
        topScopesByCount: scopesResult.rows.map((row) => ({
          scope: row.scope,
          count: Number(row.count),
          chars: Number(row.chars),
        })),
        quotas: {
          hotMaxEntries: deps.config.gc.hotMaxEntries,
          maxTotalChars: deps.config.gc.maxTotalChars,
        },
      };
    },

    async runDecayNow(): Promise<DecaySweepStats> {
      // Flush the access tracker first — same order as the cron handler so
      // a manual run gets the same behaviour as a scheduled one.
      try {
        const flushStats = await deps.accessTracker.flush({
          pool: deps.pool,
          tenantId: deps.tenantId,
        });
        lastAccessFlush = { at: new Date().toISOString(), stats: flushStats };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[graph-lifecycle] manual access-flush failed: ${msg}`);
      }

      const stats = await runDecaySweep({
        pool: deps.pool,
        tenantId: deps.tenantId,
        lambda: deps.config.decay.lambda,
        hotToWarmScoreThreshold: deps.config.decay.hotToWarmScoreThreshold,
        hotToWarmIdleDays: deps.config.decay.hotToWarmIdleDays,
        warmToColdScoreThreshold: deps.config.decay.warmToColdScoreThreshold,
        warmToColdIdleDays: deps.config.decay.warmToColdIdleDays,
        doneTaskTtlHours: deps.config.decay.doneTaskTtlHours,
        log,
      });
      lastDecaySweep = { at: new Date().toISOString(), stats };
      return stats;
    },

    async runGcNow(): Promise<GcSweepStats> {
      const stats = await runGcSweep({
        pool: deps.pool,
        tenantId: deps.tenantId,
        hotMaxEntries: deps.config.gc.hotMaxEntries,
        maxTotalChars: deps.config.gc.maxTotalChars,
        typeWeights: deps.config.gc.typeWeights,
        log,
      });
      lastGcSweep = { at: new Date().toISOString(), stats };
      return stats;
    },

    async runAccessFlushNow(): Promise<AccessTrackerFlushStats> {
      const stats = await deps.accessTracker.flush({
        pool: deps.pool,
        tenantId: deps.tenantId,
      });
      lastAccessFlush = { at: new Date().toISOString(), stats };
      return stats;
    },

    lastDecay(): LastSweep<DecaySweepStats> | null {
      return lastDecaySweep;
    },
    lastGc(): LastSweep<GcSweepStats> | null {
      return lastGcSweep;
    },
    lastAccessFlush(): LastSweep<AccessTrackerFlushStats> | null {
      return lastAccessFlush;
    },
  } as LifecycleService;
}
