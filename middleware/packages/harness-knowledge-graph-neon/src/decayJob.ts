import type { Pool } from 'pg';

/**
 * @omadia/knowledge-graph-neon — Decay-Score + Tier-Rotation sweep
 * (palaia Phase 4 / OB-73, Slice A+B).
 *
 * Single sweep that the kernel `JobScheduler` triggers on a cron schedule.
 * Pure SQL — every per-row computation runs inside Postgres so 11k+ rows
 * cost one round-trip, not 11k.
 *
 * Sequence per sweep (transactional, idempotent):
 *
 *   1. **Decay-Score** — recompute `decay_score` for every Turn row owned
 *      by this tenant:
 *
 *          score = exp(-λ · age_days) · (1 + ln(1 + access_count))
 *
 *      where `age_days = (NOW() - COALESCE(accessed_at, created_at)) / 86400`.
 *      The `1 + ln(...)` keeps a fresh, never-accessed Turn at score 1.0
 *      instead of zeroing it out.
 *
 *   2. **HOT → WARM** — rows in `tier='HOT'` with `decay_score <
 *      hotToWarmScoreThreshold` AND idle for `hotToWarmIdleDays` flip to
 *      `tier='WARM'`. Stale-active turns stay HOT.
 *
 *   3. **WARM → COLD** — analogous with WARM→COLD thresholds.
 *
 *   4. **Done-Task TTL** — hard-delete Turn rows where `entry_type='task'
 *      AND task_status='done' AND accessed_at < NOW() - doneTaskTtlHours`.
 *      The markdown audit transcript still has the conversation; the graph
 *      drops the resolved task to keep retrieval relevant. CASCADE removes
 *      attached edges (FK ON DELETE CASCADE in `graph_init`).
 *
 * Single-flight is enforced by the caller (`ctx.jobs.register({overlap:
 * 'skip'})`) — we don't keep a local flag.
 */

export interface DecaySweepOptions {
  pool: Pool;
  tenantId: string;
  /** Daily decay-rate constant (λ). Default 0.05 ≈ ~14 day half-life. */
  lambda: number;
  /** `tier='HOT'` rows below this `decay_score` become candidates for the
   *  HOT→WARM flip (additionally must have been idle ≥ `hotToWarmIdleDays`). */
  hotToWarmScoreThreshold: number;
  /** Idle-days gate for HOT→WARM. Computed against
   *  `COALESCE(accessed_at, created_at)`. */
  hotToWarmIdleDays: number;
  /** Score threshold for WARM→COLD flip. */
  warmToColdScoreThreshold: number;
  warmToColdIdleDays: number;
  /** Hard-DELETE done tasks whose `accessed_at` is older than this. */
  doneTaskTtlHours: number;
  log?: (msg: string) => void;
}

export interface DecaySweepStats {
  /** Rows whose `decay_score` was recomputed (= every Turn for the tenant). */
  decayUpdated: number;
  hotToWarm: number;
  warmToCold: number;
  doneTasksDeleted: number;
  /** Wall-clock duration for the sweep, in milliseconds. */
  durationMs: number;
}

/**
 * Run one decay+rotation sweep. Wrapped in a single transaction so a
 * mid-sweep failure (e.g. Neon hiccup between phases) doesn't leave the
 * graph half-rotated. Idempotent: running twice in a row produces the same
 * end-state minus the freshly-elapsed time slice.
 */
export async function runDecaySweep(
  opts: DecaySweepOptions,
): Promise<DecaySweepStats> {
  const log = opts.log ?? ((msg: string): void => { console.error(msg); });
  const startedAt = Date.now();

  const client = await opts.pool.connect();
  try {
    await client.query('BEGIN');

    // ---------- Phase 1: Decay-Score recompute ----------
    // `LEAST(1.0, ...)` clamps the ln-bonus so a heavily-revisited row
    // can't push score above the 1.0 ceiling we use as the inception value.
    const decayResult = await client.query(
      `
      UPDATE graph_nodes
         SET decay_score = LEAST(
               1.0,
               EXP(
                 -$2::float8 *
                 GREATEST(
                   0.0,
                   EXTRACT(epoch FROM (NOW() - COALESCE(accessed_at, created_at))) / 86400.0
                 )
               ) * (1 + LN(1 + access_count))
             )
       WHERE tenant_id = $1
         AND type = 'Turn'
      `,
      [opts.tenantId, opts.lambda],
    );
    const decayUpdated = decayResult.rowCount ?? 0;

    // ---------- Phase 2: HOT → WARM ----------
    // Idle-gate is computed against `COALESCE(accessed_at, created_at)` so
    // freshly-ingested-but-never-read Turns can age normally.
    const hotResult = await client.query(
      `
      UPDATE graph_nodes
         SET tier = 'WARM'
       WHERE tenant_id = $1
         AND type = 'Turn'
         AND tier = 'HOT'
         AND decay_score < $2::float8
         AND COALESCE(accessed_at, created_at) < NOW() - ($3::int * INTERVAL '1 day')
      `,
      [opts.tenantId, opts.hotToWarmScoreThreshold, opts.hotToWarmIdleDays],
    );
    const hotToWarm = hotResult.rowCount ?? 0;

    // ---------- Phase 3: WARM → COLD ----------
    const warmResult = await client.query(
      `
      UPDATE graph_nodes
         SET tier = 'COLD'
       WHERE tenant_id = $1
         AND type = 'Turn'
         AND tier = 'WARM'
         AND decay_score < $2::float8
         AND COALESCE(accessed_at, created_at) < NOW() - ($3::int * INTERVAL '1 day')
      `,
      [opts.tenantId, opts.warmToColdScoreThreshold, opts.warmToColdIdleDays],
    );
    const warmToCold = warmResult.rowCount ?? 0;

    // ---------- Phase 4: Done-Task TTL hard-DELETE ----------
    // Only deletes the Turn node — markdown transcripts on disk + the
    // session row stay (the session-level audit log is intentional).
    const doneResult = await client.query(
      `
      DELETE FROM graph_nodes
       WHERE tenant_id = $1
         AND type = 'Turn'
         AND entry_type = 'task'
         AND task_status = 'done'
         AND COALESCE(accessed_at, created_at) < NOW() - ($2::int * INTERVAL '1 hour')
      `,
      [opts.tenantId, opts.doneTaskTtlHours],
    );
    const doneTasksDeleted = doneResult.rowCount ?? 0;

    await client.query('COMMIT');

    const durationMs = Date.now() - startedAt;
    log(
      `[graph-decay] sweep done updated=${String(decayUpdated)} hot→warm=${String(hotToWarm)} warm→cold=${String(warmToCold)} done-deleted=${String(doneTasksDeleted)} (${String(durationMs)}ms)`,
    );

    return {
      decayUpdated,
      hotToWarm,
      warmToCold,
      doneTasksDeleted,
      durationMs,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // swallow — primary error is reported below
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`[graph-decay] sweep failed (rolled back): ${message}`);
    throw err;
  } finally {
    client.release();
  }
}
