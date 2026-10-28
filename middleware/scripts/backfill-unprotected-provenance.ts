/**
 * #1540 path 4 — mark legacy notes, rule promotions, raw MCP results and
 * stored processes that hold a value the Privacy Shield would mask
 * (`runProvenanceBackfill`, `harness-orchestrator-extras/src/provenanceBackfill.ts`).
 *
 * Detection: the guard's C0 identity baseline (e-mail, IBAN, phone, address,
 * ID number) plus, when `PRIVACY_C1_DETECTOR_URL` is set, the C1 sidecar's
 * person and address spans. A detector failure aborts the run.
 *
 * Usage (DRY-RUN by default — lists what it would mark, writes nothing):
 *   npx tsx scripts/backfill-unprotected-provenance.ts --before 2026-10-28T16:00:00Z
 *   npx tsx scripts/backfill-unprotected-provenance.ts --before 2026-10-28T16:00:00Z --apply
 *
 * `--before` is required: the deploy time of #1587, so content written with
 * provenance is never reclassified.
 * Env: DATABASE_URL (required), GRAPH_TENANT_ID (default 'default'),
 *      PRIVACY_C1_DETECTOR_URL (optional).
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { runProvenanceBackfill } from '@omadia/orchestrator-extras';
import { baselineHasIdentityPii, createC1HttpDetector } from '@omadia/plugin-privacy-guard';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) throw new Error('DATABASE_URL required');
  const beforeRaw = arg('--before');
  const before = beforeRaw ? new Date(beforeRaw) : undefined;
  if (!before || Number.isNaN(before.getTime())) throw new Error('--before <ISO instant> required');
  const apply = process.argv.includes('--apply');
  const c1Url = process.env['PRIVACY_C1_DETECTOR_URL']?.trim();
  const c1 = createC1HttpDetector({ resolveUrl: () => c1Url });

  console.log(
    `[provenance-backfill] mode=${apply ? 'APPLY' : 'DRY-RUN'} before=${before.toISOString()} c1=${c1Url ? 'on' : 'off'}`,
  );
  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  try {
    await runProvenanceBackfill({
      pool,
      tenantId: process.env['GRAPH_TENANT_ID'] ?? 'default',
      before,
      apply,
      detect: async (text) => {
        if (baselineHasIdentityPii(text)) return true;
        // The detector only asks the sidecar for person and address labels.
        return (await c1.detect(text)).length > 0;
      },
      log: (m) => console.log(m),
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[provenance-backfill] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
