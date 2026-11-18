import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

// Source imports, not the barrel — see usageDashboard.pg.test.ts.
import { getUsageDashboard } from '../packages/harness-usage-telemetry/src/queries.js';
import {
  flush,
  initUsageRecorder,
  recordUsage,
  shutdownUsageRecorder,
} from '../packages/harness-usage-telemetry/src/recorder.js';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * #1389 — "price unknown" against a real `token_usage` table (own schema). The
 * seed is written the way the recorder writes it today: an unpriced model at
 * $0. A $0 row of a model that is priced by now (written before its price was
 * added) must come back priced, without touching the stored row.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'usageDashboardUnpriced',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
});

const SCHEMA = 's4a_usage_unpriced';
const MIGRATIONS = [
  '0028_token_usage.sql',
  '0032_token_usage_subscription.sql',
  '0033_token_usage_attribution.sql',
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

function row(
  source: string,
  model: string,
  costUsd: number,
  extra: Partial<Parameters<typeof recordUsage>[0]> = {},
): void {
  recordUsage({
    source,
    model,
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    occurredAt: new Date('2026-03-02T10:00:00Z'),
    ...extra,
  });
}

before(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  for (const file of MIGRATIONS) {
    await pool.query(await readFile(resolve(migrationsDir, file), 'utf8'));
  }
  initUsageRecorder(pool);
  // A priced call, recorded at its price.
  row('orchestrator', 'claude-opus-5', 5);
  // Two calls of a model with no price entry, recorded at $0.
  row('orchestrator', 'llama3.3:70b', 0);
  row('fact-extractor', 'llama3.3:70b', 0);
  // A Sonnet 5.5 call written at $0 before the model had a price: 1M input at
  // today's $2/MTok.
  row('summariser', 'claude-sonnet-5-5', 0);
  // A $0 row with no tokens at all is not a pricing gap.
  row('probe', 'llama3.3:70b', 0, { inputTokens: 0 });
  // A subscription call bills $0 by design — not "price unknown".
  row('claude-cli', 'mystery-cli-model', 0, { referenceCostUsd: 0 });
  await flush();
});

after(async () => {
  await shutdownUsageRecorder();
  await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await pool?.end().catch(() => undefined);
});

describe('#1389 — price unknown, resolved at read time', () => {
  it('counts unpriced calls and keeps them out of the total', { skip }, async () => {
    const { totals } = await getUsageDashboard(pool!, {}, 'day');
    assert.equal(totals.unpricedCalls, 2);
    assert.deepEqual(totals.unpricedModels, ['llama3.3:70b']);
    // $5 billed + $2 for the Sonnet row priced at read time.
    assert.ok(Math.abs(totals.costUsd - 7) < 1e-9, `total ${totals.costUsd}`);
  });

  it('marks the model row and the source rows', { skip }, async () => {
    const { byModel, bySource } = await getUsageDashboard(pool!, {}, 'day');
    const llama = byModel.find((m) => m.key === 'llama3.3:70b');
    assert.equal(llama?.unpricedCalls, 2);
    assert.equal(llama?.calls, 3, 'the tokenless probe row still counts as a call');
    assert.equal(llama?.costUsd, 0);
    assert.equal(byModel.find((m) => m.key === 'mystery-cli-model')?.unpricedCalls, undefined);
    assert.equal(bySource.find((s) => s.key === 'orchestrator')?.unpricedCalls, 1);
    assert.equal(bySource.find((s) => s.key === 'fact-extractor')?.unpricedCalls, 1);
    assert.equal(bySource.find((s) => s.key === 'claude-cli')?.unpricedCalls, undefined);
  });

  it('prices a $0 row whose model has a price now, without rewriting it', { skip }, async () => {
    const { byModel, bySource, timeSeries } = await getUsageDashboard(
      pool!,
      { since: '2026-03-02T00:00:00Z', until: '2026-03-02T23:00:00Z' },
      'day',
    );
    const sonnet = byModel.find((m) => m.key === 'claude-sonnet-5-5');
    assert.ok(Math.abs((sonnet?.costUsd ?? 0) - 2) < 1e-9);
    assert.equal(sonnet?.unpricedCalls, undefined);
    assert.ok(Math.abs((bySource.find((s) => s.key === 'summariser')?.costUsd ?? 0) - 2) < 1e-9);
    assert.equal(timeSeries.length, 1);
    assert.ok(Math.abs((timeSeries[0]?.costUsd ?? 0) - 7) < 1e-9);
    const stored = await pool!.query<{ cost_usd: string }>(
      `SELECT cost_usd FROM token_usage WHERE model = 'claude-sonnet-5-5'`,
    );
    assert.equal(Number(stored.rows[0]?.cost_usd), 0, 'the ledger is append-only; nothing is backfilled');
  });

  it('puts a repriced row into its local hour bucket (non-UTC zone)', { skip }, async () => {
    // 10:00Z is 11:00 in Berlin (CET); the bar starts at 10:00Z either way,
    // but the series is cut in Berlin and must line up with the repriced row.
    const { timeSeries } = await getUsageDashboard(
      pool!,
      { since: '2026-03-02T08:30:00Z', until: '2026-03-02T11:30:00Z' },
      'hour',
      'Europe/Berlin',
    );
    const bar = timeSeries.find((b) => b.bucket === '2026-03-02T10:00:00.000Z');
    assert.ok(bar, 'the 11:00 Berlin bucket exists');
    assert.ok(Math.abs(bar.costUsd - 7) < 1e-9, `bar ${bar.costUsd}`);
    const rest = timeSeries.filter((b) => b !== bar).reduce((a, b) => a + b.costUsd, 0);
    assert.equal(rest, 0);
  });
});
