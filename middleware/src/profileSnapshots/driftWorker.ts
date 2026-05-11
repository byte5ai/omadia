/**
 * Phase 2.3 — Drift-Worker (OB-65).
 *
 * Background sweep that, for every profile with a deploy-ready snapshot,
 * compares the snapshot to the current live state and persists a 0-1 drift
 * score plus the diverged-asset list into `profile_health_score`. The
 * cron-job is registered in middleware bootstrap (3:00 UTC daily); the
 * same `runDriftSweep` is also exported so the admin route can trigger an
 * on-demand sweep without a public `runNow` on JobScheduler.
 *
 * Design notes:
 * - Per-profile failure isolated via `Promise.allSettled`. A DB-error in
 *   one profile must not abort drift-detection for the rest.
 * - Score is normalised to 0-1 in DB (NUMERIC(5,4) cannot store 100).
 *   The 0-100 integer is the public surface; the fraction is internal.
 * - Read-only against `profile_snapshot`/_asset; write-only into
 *   `profile_health_score`. SnapshotService stays audit-free per the
 *   architecture rule — drift is a read operation.
 * - Profiles without a deploy-ready snapshot are skipped (the operator
 *   hasn't released a baseline; drift-detection is semantically
 *   meaningless without one).
 */

import type { Pool } from 'pg';

import {
  computeHealthScore,
  type HealthScoreResult,
} from './healthScore.js';
import type { SnapshotService } from './snapshotService.js';

export interface DriftWorkerDeps {
  pool: Pool;
  snapshotService: SnapshotService;
  log?: (msg: string) => void;
}

export interface PerProfileSweepOutcome {
  profileId: string;
  status: 'ok' | 'no-baseline' | 'error';
  snapshotId?: string;
  score?: number;
  divergedCount?: number;
  error?: string;
}

export interface DriftSweepResult {
  startedAt: Date;
  finishedAt: Date;
  profiles: PerProfileSweepOutcome[];
}

interface DeployReadyRow {
  profile_id: string;
  snapshot_id: string;
}

const SELECT_LATEST_DEPLOY_READY_SQL = `
  SELECT DISTINCT ON (profile_id)
    profile_id,
    id AS snapshot_id
  FROM profile_snapshot
  WHERE is_deploy_ready = true
  ORDER BY profile_id, deploy_ready_at DESC NULLS LAST, created_at DESC
`;

const INSERT_HEALTH_SCORE_SQL = `
  INSERT INTO profile_health_score
    (snapshot_id, drift_score, diverged_assets, notes)
  VALUES ($1, $2, $3::jsonb, $4)
`;

/**
 * Run one drift-sweep over every profile with a deploy-ready snapshot.
 * Used by both the cron handler and the admin "run now" route.
 */
export async function runDriftSweep(
  deps: DriftWorkerDeps,
  signal?: AbortSignal,
): Promise<DriftSweepResult> {
  const startedAt = new Date();
  const log = deps.log ?? ((m) => console.log(m));

  const baselines = await loadDeployReadyBaselines(deps.pool);
  log(
    `[drift-worker] starting sweep over ${baselines.length} profile(s) with deploy-ready snapshots`,
  );

  const settled = await Promise.allSettled(
    baselines.map((row) =>
      sweepOneProfile(deps, row, signal).catch((err): PerProfileSweepOutcome => {
        const message = err instanceof Error ? err.message : String(err);
        return {
          profileId: row.profile_id,
          status: 'error',
          snapshotId: row.snapshot_id,
          error: message,
        };
      }),
    ),
  );

  const profiles: PerProfileSweepOutcome[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const row = baselines[i]!;
    return {
      profileId: row.profile_id,
      status: 'error',
      snapshotId: row.snapshot_id,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });

  const finishedAt = new Date();
  const okCount = profiles.filter((p) => p.status === 'ok').length;
  const errCount = profiles.filter((p) => p.status === 'error').length;
  log(
    `[drift-worker] sweep done in ${finishedAt.getTime() - startedAt.getTime()}ms — ok=${okCount} err=${errCount}`,
  );

  return { startedAt, finishedAt, profiles };
}

async function loadDeployReadyBaselines(pool: Pool): Promise<DeployReadyRow[]> {
  const res = await pool.query<DeployReadyRow>(SELECT_LATEST_DEPLOY_READY_SQL);
  return res.rows;
}

async function sweepOneProfile(
  deps: DriftWorkerDeps,
  row: DeployReadyRow,
  signal?: AbortSignal,
): Promise<PerProfileSweepOutcome> {
  if (signal?.aborted) {
    return {
      profileId: row.profile_id,
      status: 'error',
      snapshotId: row.snapshot_id,
      error: 'aborted',
    };
  }

  const diffs = await deps.snapshotService.diff({
    base: { kind: 'snapshot', snapshotId: row.snapshot_id },
    target: { kind: 'live', profileId: row.profile_id },
  });

  const score = computeHealthScore({ diffs });
  await persistHealthScore(deps.pool, row.snapshot_id, score);

  return {
    profileId: row.profile_id,
    status: 'ok',
    snapshotId: row.snapshot_id,
    score: score.score,
    divergedCount: score.divergedAssets.length,
  };
}

async function persistHealthScore(
  pool: Pool,
  snapshotId: string,
  result: HealthScoreResult,
): Promise<void> {
  // DB column is NUMERIC(5,4) so we store the fraction. The 0-100 integer
  // is the public surface (API + UI).
  const fraction = (result.score / 100).toFixed(4);
  const divergedJson = JSON.stringify({
    score: result.score,
    divergedAssets: result.divergedAssets,
    suggestions: result.suggestions,
  });
  await pool.query(INSERT_HEALTH_SCORE_SQL, [
    snapshotId,
    fraction,
    divergedJson,
    null,
  ]);
}

/**
 * JobSpec helper — kernel-internal cron registration. Daily at 03:00 UTC,
 * 5-minute timeout, skip-overlap so a long sweep doesn't get re-fired by
 * the next tick. The agentId is `@kernel/drift-detector`; this lets the
 * scheduler's `stopForPlugin` semantics work uniformly even though no
 * plugin owns the job.
 */
export const DRIFT_DETECTOR_AGENT_ID = '@kernel/drift-detector';
export const DRIFT_DETECTOR_JOB_NAME = 'drift-detector';
export const DRIFT_DETECTOR_CRON = '0 3 * * *';
export const DRIFT_DETECTOR_TIMEOUT_MS = 5 * 60_000;
