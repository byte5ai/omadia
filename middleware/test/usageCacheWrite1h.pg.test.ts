import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

// Source imports, not the barrel: the barrel resolves to `dist/`.
import { getUsageDashboard } from '../packages/harness-usage-telemetry/src/queries.js';
import {
  flush,
  initUsageRecorder,
  recordUsage,
  shutdownUsageRecorder,
} from '../packages/harness-usage-telemetry/src/recorder.js';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * Graph migration 0036 — the 1-hour cache-write split lands in `token_usage`
 * and both halves of the ledger price it at 2×: `cost_usd` at write time, the
 * dashboard's cache saving at read time.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'usageCacheWrite1h',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
});

const SCHEMA = 'cache_write_1h_ledger';
const MIGRATIONS = [
  '0028_token_usage.sql',
  '0032_token_usage_subscription.sql',
  '0033_token_usage_attribution.sql',
  '0036_token_usage_cache_write_1h.sql',
];
const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'harness-knowledge-graph-neon',
  'src',
  'migrations',
);

const pool = pgAvailable
  ? new Pool({
      connectionString: PG_URL,
      max: 2,
      idleTimeoutMillis: 1_000,
      options: `-c search_path=${SCHEMA} -c TimeZone=UTC`,
    })
  : undefined;

const skip = pgAvailable ? false : 'no test Postgres reachable';

before(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const file of MIGRATIONS) {
      await pool.query(await readFile(resolve(migrationsDir, file), 'utf8'));
    }
  }
  initUsageRecorder(pool);
  // Opus 5.5 ($4/MTok): 1M writes, 400k of them with the 1-hour TTL, 1M reads.
  recordUsage({
    source: 'orchestrator',
    model: 'claude-opus-5-5',
    provider: 'anthropic',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheCreation1hTokens: 400_000,
    occurredAt: new Date('2026-11-20T10:00:00Z'),
  });
  // A malformed split: more 1-hour writes than writes. Stored clamped.
  recordUsage({
    source: 'orchestrator',
    model: 'claude-opus-5-5',
    provider: 'anthropic',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 10,
    cacheCreation1hTokens: 99,
    occurredAt: new Date('2026-11-20T11:00:00Z'),
  });
  await flush();
  const seeded = await pool.query<{ n: string }>('SELECT count(*) AS n FROM token_usage');
  assert.equal(Number(seeded.rows[0]?.n), 2, 'the recorder wrote every seed row');
});

after(async () => {
  await shutdownUsageRecorder();
  await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await pool?.end().catch(() => undefined);
});

describe('token_usage.cache_creation_1h_tokens', () => {
  it('stores the split (clamped) and a cost priced per TTL', { skip }, async () => {
    const { rows } = await pool!.query<{ cw: string; cw1h: string; cost: string }>(
      `SELECT cache_creation_tokens AS cw, cache_creation_1h_tokens AS cw1h, cost_usd AS cost
         FROM token_usage ORDER BY created_at`,
    );
    assert.deepEqual(
      rows.map((r) => [Number(r.cw), Number(r.cw1h), Number(r.cost)]),
      [
        // reads $0.20 + 600k × 1.25 × $4/MTok ($3.00) + 400k × 2 × $4/MTok ($3.20)
        [1_000_000, 400_000, 6.4],
        [10, 10, 0.00008],
      ],
    );
  });

  it('prices the dashboard cache saving with the 2× premium for 1-hour writes', { skip }, async () => {
    const { totals } = await getUsageDashboard(pool!);
    // reads save $3.80; premiums: 600k × 0.25 × $4 = $0.60, 400k + 10 at 1 × $4 = $1.60004.
    assert.equal(totals.cacheSavingsUsd, 1.59996);
  });
});
