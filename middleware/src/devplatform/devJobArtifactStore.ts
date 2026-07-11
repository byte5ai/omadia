/**
 * Epic #470 W0 — `dev_job_artifacts` access, split out of `DevJobStore` to keep
 * both files under the repo's 500-line rule.
 *
 * Standalone functions over a `Pool` rather than a second class: they carry no
 * state, and `DevJobStore` delegates so callers keep a single store surface.
 *
 * `kind` is validated here rather than by the database. Migration 0022
 * deliberately dropped the CHECK on `dev_job_artifacts.kind` — the enum grows
 * in W1 through W3 — so TypeScript is the only enforcement left.
 */

import type { Pool } from 'pg';

import { asObj, iso, str, type Row } from './pgMappers.js';
import { isDevJobArtifactKind, type DevJobArtifact, type DevJobArtifactKind } from './types.js';

const ARTIFACT_COLS = 'id, job_id, kind, content, meta, created_at';

/** Postgres rejects a malformed uuid with 22P02; refuse it before the query. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toArtifact(r: Row): DevJobArtifact {
  return {
    id: str(r['id']),
    jobId: str(r['job_id']),
    kind: str(r['kind']) as DevJobArtifactKind,
    content: str(r['content']),
    meta: asObj(r['meta'], {}),
    createdAt: iso(r['created_at']),
  };
}

/**
 * Does this artifact belong to this job?
 *
 * The runner names its own diff artifact in `POST /result`. Without this check
 * the middleware would carry another job's diff into this job's apply and pull
 * request — and the epic's guarantee is that what was reviewed and what was
 * committed are the same object. Artifact ids are opaque, so this is defence in
 * depth rather than the only control; it exists so that some layer owns the
 * check instead of each assuming the other does.
 */
export async function artifactBelongsToJob(
  pool: Pool,
  jobId: string,
  artifactId: string,
): Promise<boolean> {
  if (!UUID_RE.test(artifactId)) return false;
  const r = await pool.query(`SELECT 1 FROM dev_job_artifacts WHERE id = $1 AND job_id = $2`, [
    artifactId,
    jobId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

export async function addArtifact(
  pool: Pool,
  jobId: string,
  kind: string,
  content: string,
  meta: Record<string, unknown> = {},
): Promise<string> {
  if (!isDevJobArtifactKind(kind)) {
    throw new TypeError(`addArtifact: invalid artifact kind '${kind}'`);
  }
  const r = await pool.query<Row>(
    `INSERT INTO dev_job_artifacts (job_id, kind, content, meta)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [jobId, kind, content, JSON.stringify(meta)],
  );
  return str(r.rows[0]!['id']);
}

export async function getArtifact(pool: Pool, id: string): Promise<DevJobArtifact | null> {
  if (!UUID_RE.test(id)) return null;
  const r = await pool.query<Row>(`SELECT ${ARTIFACT_COLS} FROM dev_job_artifacts WHERE id = $1`, [
    id,
  ]);
  return r.rows[0] ? toArtifact(r.rows[0]) : null;
}

export async function listArtifacts(pool: Pool, jobId: string): Promise<DevJobArtifact[]> {
  const r = await pool.query<Row>(
    `SELECT ${ARTIFACT_COLS} FROM dev_job_artifacts WHERE job_id = $1 ORDER BY created_at ASC`,
    [jobId],
  );
  return r.rows.map(toArtifact);
}

/**
 * The most recent artifact of a kind for a job, or null. W2's gate opens on the
 * `clarify` phase but must pin the `plan` artifact — which was persisted a phase
 * earlier — so it looks it up here rather than trusting the transient clarify
 * result (which carries no plan). `DESC LIMIT 1` = the latest, which on a
 * re-implement round is the plan the human actually approved.
 */
export async function getLatestArtifact(
  pool: Pool,
  jobId: string,
  kind: string,
): Promise<DevJobArtifact | null> {
  const r = await pool.query<Row>(
    `SELECT ${ARTIFACT_COLS} FROM dev_job_artifacts
      WHERE job_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1`,
    [jobId, kind],
  );
  return r.rows[0] ? toArtifact(r.rows[0]) : null;
}
