/**
 * Epic #470 W5 — dev-transcript CLI (spec §7 data lifecycle + §10 transcript tooling).
 *
 * Verbs:
 *   - `purge`  — delete terminal dev-jobs (and, via 0022's ON DELETE CASCADE,
 *                their events + artifacts) older than a retention window.
 *   - `list`   — a job's artifacts (kind, size, created_at, storage).
 *   - `export` — a job's artifacts as JSONL to stdout; `--redact` scrubs secrets.
 *   - `search` — SQL ILIKE over `dev_job_artifacts.content`; `--since` filters by age.
 *
 * CLI-only by design (spec §10): there is no search UI — the JSONL export IS the
 * SIEM feed.
 *
 * Usage:
 *   npx tsx scripts/dev-transcript.ts purge --older-than 365
 *   npx tsx scripts/dev-transcript.ts purge                 # defaults to
 *                                                            # DEV_PLATFORM_AUDIT_RETENTION_DAYS
 *   npx tsx scripts/dev-transcript.ts purge --older-than 30 --dry-run
 *   npx tsx scripts/dev-transcript.ts list <jobId>
 *   npx tsx scripts/dev-transcript.ts export <jobId> [--redact] > job.jsonl
 *   npx tsx scripts/dev-transcript.ts search '<query>' [--since 2026-01-01T00:00:00Z]
 *
 * Env: DATABASE_URL (required),
 *      DEV_PLATFORM_AUDIT_RETENTION_DAYS (default 365, used when --older-than omitted).
 */
import 'dotenv/config';
import { Pool } from 'pg';

import { redactSecrets } from '../src/devplatform/policy/scanForSecrets.js';
import { DevRetentionRunner } from '../src/devplatform/retention.js';
import {
  exportJobArtifacts,
  listJobArtifacts,
  searchArtifacts,
} from '../src/devplatform/transcriptQueries.js';

const TERMINAL_STATUSES = ['done', 'failed', 'cancelled', 'stalled', 'budget_exceeded'];

function log(msg: string): void {
  console.log(msg);
}

function parseOlderThan(argv: string[]): number | null {
  const i = argv.indexOf('--older-than');
  if (i === -1) return null;
  const raw = argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--older-than must be a positive integer number of days (got '${String(raw)}')`);
  }
  return n;
}

async function purge(argv: string[]): Promise<void> {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) throw new Error('DATABASE_URL required');

  const auditDefault = Number(process.env['DEV_PLATFORM_AUDIT_RETENTION_DAYS'] ?? '365');
  const olderThan = parseOlderThan(argv) ?? auditDefault;
  const dryRun = argv.includes('--dry-run');

  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  try {
    if (dryRun) {
      // Count what WOULD be purged without deleting anything.
      const cutoff = new Date(Date.now() - olderThan * 86_400_000);
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::bigint AS n FROM dev_jobs
          WHERE status = ANY($1::text[]) AND ended_at IS NOT NULL AND ended_at < $2`,
        [TERMINAL_STATUSES, cutoff],
      );
      log(`[dev-transcript] DRY-RUN: ${r.rows[0]?.n ?? '0'} terminal job(s) older than ${String(olderThan)}d would be purged`);
      return;
    }
    const runner = new DevRetentionRunner(pool, {
      // Only purgeTerminalJobs is exercised here; the event windows are required by
      // the constructor but not used by the purge path.
      eventRetentionDays: 30,
      auditRetentionDays: olderThan,
    });
    const purged = await runner.purgeTerminalJobs(olderThan);
    log(`[dev-transcript] purged ${String(purged)} terminal job(s) older than ${String(olderThan)}d (events + artifacts cascaded)`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Open a small pool from DATABASE_URL, run `fn`, and always close it. */
async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) throw new Error('DATABASE_URL required');
  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  try {
    return await fn(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** The first positional (non-flag) arg, or throw a usage error. */
function requirePositional(argv: string[], label: string): string {
  const v = argv.find((a) => !a.startsWith('--'));
  if (!v) throw new Error(`${label} required`);
  return v;
}

/** Value of `--since <iso>`, or undefined. */
function parseSince(argv: string[]): string | undefined {
  const i = argv.indexOf('--since');
  if (i === -1) return undefined;
  const raw = argv[i + 1];
  if (!raw || raw.startsWith('--')) throw new Error('--since requires an ISO timestamp');
  return raw;
}

async function list(argv: string[]): Promise<void> {
  const jobId = requirePositional(argv, 'jobId');
  const rows = await withPool((pool) => listJobArtifacts(pool, jobId));
  if (rows.length === 0) {
    log(`[dev-transcript] no artifacts for job ${jobId}`);
    return;
  }
  for (const r of rows) {
    log(`${r.createdAt}\t${r.kind}\t${String(r.bytes)}B\t${r.stored}\t${r.id}`);
  }
  log(`[dev-transcript] ${String(rows.length)} artifact(s) for job ${jobId}`);
}

async function exportJob(argv: string[]): Promise<void> {
  const jobId = requirePositional(argv, 'jobId');
  const redact = argv.includes('--redact');
  const rows = await withPool((pool) =>
    exportJobArtifacts(pool, jobId, { redact, redactor: (t) => redactSecrets(t) }),
  );
  // JSONL: one artifact per line. Nothing else on stdout so it pipes cleanly to a
  // SIEM. (Diagnostics go to stderr.)
  for (const r of rows) log(JSON.stringify(r));
  console.error(
    `[dev-transcript] exported ${String(rows.length)} artifact(s) for job ${jobId}${redact ? ' (redacted)' : ''}`,
  );
}

async function search(argv: string[]): Promise<void> {
  const query = requirePositional(argv, 'query');
  const since = parseSince(argv);
  const rows = await withPool((pool) => searchArtifacts(pool, query, { since }));
  for (const r of rows) {
    log(`${r.createdAt}\t${r.jobId}\t${r.kind}\t${r.id}`);
  }
  log(
    `[dev-transcript] ${String(rows.length)} artifact(s) match '${query}'${since ? ` since ${since}` : ''}`,
  );
}

const USAGE = [
  'usage:',
  '  dev-transcript.ts purge [--older-than <days>] [--dry-run]',
  '  dev-transcript.ts list <jobId>',
  '  dev-transcript.ts export <jobId> [--redact]',
  '  dev-transcript.ts search <query> [--since <iso>]',
].join('\n');

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  switch (verb) {
    case 'purge':
      await purge(rest);
      break;
    case 'list':
      await list(rest);
      break;
    case 'export':
      await exportJob(rest);
      break;
    case 'search':
      await search(rest);
      break;
    default:
      log(USAGE);
      process.exitCode = verb ? 1 : 0;
  }
}

main().catch((err: unknown) => {
  console.error(`[dev-transcript] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
