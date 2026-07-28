/**
 * Epic #470 W0 — the three worker-facing `DevJobStore` seams, split out of
 * `devJobStore.ts` to keep that file under the repo's 500-line guideline (the
 * same reason `devJobArtifactStore.ts` and `devRepoStore.ts` exist). The
 * `DevJobStore` methods are thin delegations to these free functions; the SQL
 * and the reasoning live here.
 *
 * `devJobStore.ts` imports this module and this module imports a few shared
 * constants + the row mapper back from it. That cycle is safe: every borrowed
 * binding is referenced only inside a function body, never at module-eval time,
 * so ESM's live bindings are resolved by the time any of these runs.
 */

import type { Pool } from 'pg';

import {
  ACTIVE_SET_SQL,
  DevJobLeaseLostError,
  JOB_COLS,
  TERMINAL_SET_SQL,
  UUID_RE,
  toJob,
} from './devJobStore.js';
import { mintRunnerToken } from './jobToken.js';
import { num, type Row } from './pgMappers.js';
import type { DevJob } from './types.js';

/**
 * How many jobs currently occupy a runner slot — every non-terminal status that
 * a `provision()` has (or will imminently) put a runner behind: `provisioning`,
 * `running`, and `applying`. The worker's concurrency gate computes
 * `MAX_CONCURRENT − countActiveJobs()`, so counting `applying` too keeps a
 * mid-apply job holding its slot: a restart then never over-provisions past
 * `DEV_PLATFORM_MAX_CONCURRENT_JOBS` while an apply is still in flight.
 */
export async function countActiveJobs(pool: Pool): Promise<number> {
  const r = await pool.query<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM dev_jobs WHERE status IN (${ACTIVE_SET_SQL})`,
  );
  return num(r.rows[0]?.n ?? 0);
}

/**
 * Map a reaped runner handle back to the still-active job that owns it, WITHOUT
 * depending on heartbeat freshness (a runner can die between beats, so a stall
 * scan would miss it). Matches on `runner_handle->>'id'` and — critically —
 * EXCLUDES `applying`: that phase has no live runner by design (the shim posted
 * its diff and exited 0), so matching it would let the reaper finalize a
 * normally-completing job as `stalled` and strand its PR (see
 * `isHostSideApplyPhase` in devJobWorkerPolicy.ts). Only `provisioning`/`running`
 * jobs have a runner a reap result can legitimately belong to.
 */
export async function findActiveByHandleId(pool: Pool, handleId: string): Promise<DevJob | null> {
  const r = await pool.query<Row>(
    `SELECT ${JOB_COLS} FROM dev_jobs
      WHERE runner_handle->>'id' = $1 AND status IN ('provisioning', 'running')
      ORDER BY started_at DESC NULLS LAST LIMIT 1`,
    [handleId],
  );
  return r.rows[0] ? toJob(r.rows[0]) : null;
}

/**
 * Prepare a claimed job for `provision()`: mint the ONE-TIME runner token and
 * pin the job's `branch` + `base_sha` in a single lease-fenced write, returning
 * the plaintext token for the backend's provision input plus the refreshed job.
 *
 * The create route deliberately discards its placeholder token's plaintext
 * (`devPlatform.ts` — "the worker unit mints the token it hands to the
 * backend"): the plaintext produced HERE is the only one a backend ever sees,
 * and only its sha256 lands in `runner_token_hash`. Branch and base_sha are
 * COALESCE-pinned, so a re-provision (W2) never clobbers an existing pin.
 * Lease-fenced (`claimed_by = $lease`, non-terminal): a 0-row update means the
 * lease was lost, so we abort with `DevJobLeaseLostError` rather than mint a
 * token for a job we no longer own.
 *
 * `baseSha` resolution is the caller's job (it needs the forge; the store does
 * not): the wiring passes a resolved sha when it has one. In W0 it is typically
 * left unpinned — see the wire unit's spec-delta note.
 */
export async function prepareProvision(
  pool: Pool,
  job: DevJob,
  lease: string,
  baseSha?: string | null,
): Promise<{ token: string; job: DevJob }> {
  if (!UUID_RE.test(lease)) {
    throw new TypeError(`prepareProvision: lease must be a UUID (got '${lease}')`);
  }
  const minted = mintRunnerToken();
  const branch = job.branch ?? jobBranchName(job);
  const r = await pool.query<Row>(
    `UPDATE dev_jobs
        SET runner_token_hash = $3,
            branch = COALESCE(branch, $4),
            base_sha = COALESCE(base_sha, $5),
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2 AND status NOT IN (${TERMINAL_SET_SQL})
      RETURNING ${JOB_COLS}`,
    [job.id, lease, minted.hash, branch, baseSha ?? null],
  );
  if (!r.rows[0]) throw new DevJobLeaseLostError(job.id);
  return { token: minted.token, job: toJob(r.rows[0]) };
}

/**
 * The authoritative `omadia/job-<id8>-<slug>` branch pinned before provision.
 * `id8` is the leading 8 alphanumerics of the job id; the slug (issue number,
 * when the job came from a tracker ticket) is sanitized to the job-branch
 * charset so `assertJobBranch` in githubForgeClient.ts always accepts it.
 */
export function jobBranchName(job: DevJob): string {
  const id8 = job.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'job';
  let slug = '';
  const issue = job.sourceRef ? /(\d+)/.exec(job.sourceRef) : null;
  if (issue) slug = `issue-${issue[1]}`;
  slug = slug
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug ? `omadia/job-${id8}-${slug}` : `omadia/job-${id8}`;
}
