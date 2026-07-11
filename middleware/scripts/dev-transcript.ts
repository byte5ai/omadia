/**
 * Epic #470 W5 — dev-transcript CLI (spec §7 data lifecycle).
 *
 * Only the `purge` verb ships in this W5 unit; the `list`/`export`/`search` verbs
 * are a separate W5 unit. `purge` deletes terminal dev-jobs (and, via 0022's
 * ON DELETE CASCADE, their events + artifacts) older than a retention window.
 *
 * Usage:
 *   npx tsx scripts/dev-transcript.ts purge --older-than 365
 *   npx tsx scripts/dev-transcript.ts purge                 # defaults to
 *                                                            # DEV_PLATFORM_AUDIT_RETENTION_DAYS
 *   npx tsx scripts/dev-transcript.ts purge --older-than 30 --dry-run
 *
 * Env: DATABASE_URL (required),
 *      DEV_PLATFORM_AUDIT_RETENTION_DAYS (default 365, used when --older-than omitted).
 */
import 'dotenv/config';
import { Pool } from 'pg';

import { DevRetentionRunner } from '../src/devplatform/retention.js';

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

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  switch (verb) {
    case 'purge':
      await purge(rest);
      break;
    default:
      log('usage: dev-transcript.ts purge [--older-than <days>] [--dry-run]');
      process.exitCode = verb ? 1 : 0;
  }
}

main().catch((err: unknown) => {
  console.error(`[dev-transcript] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
