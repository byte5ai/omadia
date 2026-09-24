import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

// Source imports, not the barrel: the barrel resolves to `dist/`, so a
// mutation check against `src/` would otherwise need a rebuild to show red.
import { getUsageDashboard } from '../packages/harness-usage-telemetry/src/queries.js';
import {
  flush,
  initUsageRecorder,
  recordUsage,
  shutdownUsageRecorder,
} from '../packages/harness-usage-telemetry/src/recorder.js';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * OM-103 / #1077 — `getUsageDashboard` against a real `token_usage` table.
 *
 * The aggregation is pure SQL, so a fake pool could only assert on the SQL
 * text. This applies the three real graph migrations that define the table
 * (0028 create, 0032 `reference_cost_usd`, 0033 `turn_id`/`provider`) into a
 * private schema, writes rows through the real recorder, and reads them back
 * through the real query — which also pins the write/read contract between
 * the two halves of the package.
 *
 * What it guards:
 *  - `subscriptionCalls` counts exactly the two subscription sources, not a
 *    `claude-cli%` prefix (the decoy row below would be folded in by one);
 *  - `referenceCostUsd` is reported beside `costUsd` and never summed into it;
 *  - cache-hit ratio, per-key breakdowns, the window and the time buckets.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'usageDashboard',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
});

const SCHEMA = 'om103_usage_dashboard';
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

// UTC pinned per connection: `date_trunc('day', timestamptz)` truncates in the
// session time zone, and the day buckets below are written in UTC.
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
  // Twice: the migrations are applied on every boot, so they must be
  // re-runnable against an existing table.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const file of MIGRATIONS) {
      await pool.query(await readFile(resolve(migrationsDir, file), 'utf8'));
    }
  }

  initUsageRecorder(pool);
  // A metered API call: billed, warm cache.
  recordUsage({
    source: 'orchestrator',
    model: 'claude-opus-4-7',
    provider: 'anthropic',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 3000,
    cacheCreationTokens: 0,
    costUsd: 0.5,
    occurredAt: new Date('2026-01-10T10:15:00Z'),
  });
  // A subscription chat turn (CliChatAgent).
  recordUsage({
    source: 'claude-cli',
    model: 'opus',
    provider: 'claude-cli',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 900,
    cacheCreationTokens: 0,
    costUsd: 0,
    referenceCostUsd: 0.04,
    occurredAt: new Date('2026-01-10T10:45:00Z'),
  });
  // A subscription completion (claudeCliAdapter, Shape 2).
  recordUsage({
    source: 'claude-cli-completion',
    model: 'haiku-cli',
    provider: 'claude-cli',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 7,
    costUsd: 0,
    referenceCostUsd: 0.01,
    occurredAt: new Date('2026-01-10T11:20:00Z'),
  });
  // The decoy the exhaustive source list exists for: a caller-chosen source
  // that merely STARTS like a subscription one, on a billed call.
  recordUsage({
    source: 'claude-cli-something',
    model: 'opus',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.25,
    occurredAt: new Date('2026-01-11T09:00:00Z'),
  });
  await flush();
  // `flush()` swallows INSERT failures (the recorder must never break a turn),
  // so a drift between the migrations and the recorder's column list would
  // otherwise surface below as confusing zero totals. Fail here, with the cause.
  const seeded = await pool.query<{ n: string }>('SELECT count(*) AS n FROM token_usage');
  assert.equal(Number(seeded.rows[0]?.n), 4, 'the recorder wrote every seed row');
});

after(async () => {
  await shutdownUsageRecorder();
  await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await pool?.end().catch(() => undefined);
});

describe('OM-103 — getUsageDashboard over real token_usage rows', () => {
  it('counts exactly the two subscription sources and keeps reference cost out of the bill', { skip }, async () => {
    const { totals } = await getUsageDashboard(pool!);
    assert.equal(totals.calls, 4);
    assert.equal(totals.subscriptionCalls, 2, 'the claude-cli-something decoy is not a subscription call');
    assert.equal(totals.costUsd, 0.75, 'billed money only');
    assert.equal(totals.referenceCostUsd, 0.05);
    assert.equal(totals.inputTokens, 1111);
    assert.equal(totals.outputTokens, 256);
    assert.equal(totals.cacheReadTokens, 3900);
    assert.equal(totals.cacheCreationTokens, 7);
    assert.equal(totals.cacheHitRatio, 3900 / (1111 + 3900));
  });

  it('breaks cost and reference cost down per source and per model', { skip }, async () => {
    const { bySource, byModel } = await getUsageDashboard(pool!);

    // Ordered by billed cost, highest first; the two zero-cost subscription
    // sources tie, so only their membership is asserted.
    assert.deepEqual(
      bySource.slice(0, 2).map((r) => [r.key, r.costUsd]),
      [
        ['orchestrator', 0.5],
        ['claude-cli-something', 0.25],
      ],
    );
    const cli = bySource.find((r) => r.key === 'claude-cli');
    const completion = bySource.find((r) => r.key === 'claude-cli-completion');
    assert.deepEqual(
      [cli?.calls, cli?.costUsd, cli?.referenceCostUsd, cli?.cacheReadTokens],
      [1, 0, 0.04, 900],
    );
    assert.deepEqual([completion?.calls, completion?.referenceCostUsd], [1, 0.01]);

    const opus = byModel.find((r) => r.key === 'opus');
    assert.deepEqual(
      [opus?.calls, opus?.costUsd, opus?.referenceCostUsd, opus?.inputTokens],
      [2, 0.25, 0.04, 101],
    );
    assert.equal(byModel[0]?.key, 'claude-opus-4-7');
    assert.equal(byModel.length, 3);
  });

  it('restricts every aggregate to the since/until window', { skip }, async () => {
    const late = await getUsageDashboard(pool!, { since: '2026-01-10T11:00:00Z' });
    assert.equal(late.totals.calls, 2);
    assert.equal(late.totals.subscriptionCalls, 1);
    assert.equal(late.totals.costUsd, 0.25);
    assert.deepEqual(late.bySource.map((r) => r.key).sort(), [
      'claude-cli-completion',
      'claude-cli-something',
    ]);

    const firstDay = await getUsageDashboard(pool!, {
      since: '2026-01-10T00:00:00Z',
      until: '2026-01-10T23:59:59Z',
    });
    assert.equal(firstDay.totals.calls, 3);
    assert.equal(firstDay.totals.subscriptionCalls, 2);
    assert.equal(firstDay.totals.referenceCostUsd, 0.05);
    assert.equal(firstDay.timeSeries.length, 2);
  });

  it('buckets the cost series by hour or by day', { skip }, async () => {
    const hourly = await getUsageDashboard(pool!, {}, 'hour');
    assert.deepEqual(
      hourly.timeSeries.map((b) => [b.bucket, b.calls, b.costUsd]),
      [
        ['2026-01-10T10:00:00.000Z', 2, 0.5],
        ['2026-01-10T11:00:00.000Z', 1, 0],
        ['2026-01-11T09:00:00.000Z', 1, 0.25],
      ],
    );

    const daily = await getUsageDashboard(pool!, {}, 'day');
    assert.deepEqual(
      daily.timeSeries.map((b) => [b.bucket, b.calls, b.costUsd]),
      [
        ['2026-01-10T00:00:00.000Z', 3, 0.5],
        ['2026-01-11T00:00:00.000Z', 1, 0.25],
      ],
    );
  });
});
