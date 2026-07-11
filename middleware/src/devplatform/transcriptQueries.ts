/**
 * Epic #470 W5 — transcript-tooling queries (spec §10).
 *
 * The read side of `dev_job_artifacts`, backing the `list` / `export` / `search`
 * verbs of `scripts/dev-transcript.ts`. Split out of the CLI so the SQL is unit-
 * testable against a real Postgres without spawning the script; the CLI stays a
 * thin arg-parse + format shell over these functions.
 *
 * Everything here is read-only. Retention/purge is the write side and lives in
 * `retention.ts`; transcripts are stored full (operator audit toggle on) or as
 * hashes (toggle off) by the W2 audit path — this module only reports and emits
 * whatever is on the row.
 */

import type { Pool } from 'pg';

/** Postgres rejects a malformed uuid with 22P02; refuse it before the query. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How the row's content is stored, derived from `meta` (see {@link classifyStored}). */
export type ArtifactStorage = 'full' | 'hash' | 'offloaded' | 'oversized';

/** One row for `list`: audit-relevant metadata, no content. */
export interface TranscriptArtifactRow {
  id: string;
  jobId: string;
  kind: string;
  /** Byte length of the stored content (`octet_length`). */
  bytes: number;
  createdAt: string;
  stored: ArtifactStorage;
}

/** One row for `export`: the full artifact, ready to JSON-encode as a JSONL line. */
export interface TranscriptExportRow {
  id: string;
  jobId: string;
  kind: string;
  content: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** One row for `search`: identity + the matched content. */
export interface TranscriptSearchRow {
  id: string;
  jobId: string;
  kind: string;
  createdAt: string;
  content: string;
}

function requireUuid(jobId: string): void {
  if (!UUID_RE.test(jobId)) {
    throw new Error(`invalid jobId (expected a uuid): '${jobId}'`);
  }
}

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * Classify how a row is stored from its `meta` flags. The W2 audit toggle stores
 * transcripts full (toggle on) or hashed (toggle off); `addArtifact`'s ceiling
 * can also offload or mark-oversized. We report whichever the row carries, in
 * priority order, defaulting to `full`.
 */
export function classifyStored(meta: Record<string, unknown> | null | undefined): ArtifactStorage {
  const m = meta ?? {};
  if (m['offloaded'] === true) return 'offloaded';
  if (m['oversized'] === true) return 'oversized';
  if (m['hashed'] === true || m['redacted'] === true) return 'hash';
  return 'full';
}

/** `list <jobId>` — the job's artifacts (kind, byte size, created_at, storage). */
export async function listJobArtifacts(pool: Pool, jobId: string): Promise<TranscriptArtifactRow[]> {
  requireUuid(jobId);
  const r = await pool.query(
    `SELECT id, job_id, kind, octet_length(content) AS bytes, meta, created_at
       FROM dev_job_artifacts WHERE job_id = $1 ORDER BY created_at ASC, id ASC`,
    [jobId],
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    jobId: String(row.job_id),
    kind: String(row.kind),
    bytes: Number(row.bytes ?? 0),
    createdAt: isoOf(row.created_at),
    stored: classifyStored(row.meta as Record<string, unknown>),
  }));
}

/**
 * `export <jobId> [--redact]` — the job's full artifacts as parsed rows. The CLI
 * JSON-encodes each into one JSONL line. When `redact` is passed, the content is
 * scrubbed with the shared secret-scrubber before it is returned.
 */
export async function exportJobArtifacts(
  pool: Pool,
  jobId: string,
  opts: { redact: boolean; redactor?: (text: string) => string } = { redact: false },
): Promise<TranscriptExportRow[]> {
  requireUuid(jobId);
  const r = await pool.query(
    `SELECT id, job_id, kind, content, meta, created_at
       FROM dev_job_artifacts WHERE job_id = $1 ORDER BY created_at ASC, id ASC`,
    [jobId],
  );
  const scrub = opts.redact ? (opts.redactor ?? ((t: string) => t)) : (t: string) => t;
  return r.rows.map((row) => ({
    id: String(row.id),
    jobId: String(row.job_id),
    kind: String(row.kind),
    content: scrub(String(row.content)),
    meta: (row.meta as Record<string, unknown>) ?? {},
    createdAt: isoOf(row.created_at),
  }));
}

/** Escape LIKE/ILIKE metacharacters so `query` matches literally (default `\` escape). */
function escapeLike(query: string): string {
  return query.replace(/([\\%_])/g, '\\$1');
}

/**
 * `search <query> [--since <iso>]` — SQL `ILIKE` over `dev_job_artifacts.content`.
 * `--since` filters by `created_at >= since`. CLI-only by design; there is no
 * search UI (spec §10). Throws on a malformed `--since`.
 */
export async function searchArtifacts(
  pool: Pool,
  query: string,
  opts: { since?: string; limit?: number } = {},
): Promise<TranscriptSearchRow[]> {
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('search query must be a non-empty string');
  }
  const params: unknown[] = [`%${escapeLike(query)}%`];
  let sql =
    `SELECT id, job_id, kind, content, created_at
       FROM dev_job_artifacts WHERE content ILIKE $1`;
  if (opts.since !== undefined) {
    const since = new Date(opts.since);
    if (Number.isNaN(since.getTime())) {
      throw new Error(`invalid --since (expected an ISO timestamp): '${opts.since}'`);
    }
    params.push(since.toISOString());
    sql += ` AND created_at >= $${params.length}`;
  }
  sql += ` ORDER BY created_at ASC, id ASC`;
  if (opts.limit !== undefined && Number.isInteger(opts.limit) && opts.limit > 0) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const r = await pool.query(sql, params);
  return r.rows.map((row) => ({
    id: String(row.id),
    jobId: String(row.job_id),
    kind: String(row.kind),
    createdAt: isoOf(row.created_at),
    content: String(row.content),
  }));
}
