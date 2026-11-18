import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

// Source imports, not the barrel — see usageDashboard.pg.test.ts.
import {
  BUILDER_SOURCE_KEY,
  OTHER_SOURCE_KEY,
  capByKey,
  getUsageDashboard,
  type UsageByKey,
} from '../packages/harness-usage-telemetry/src/queries.js';
import {
  flush,
  initUsageRecorder,
  recordUsage,
  shutdownUsageRecorder,
} from '../packages/harness-usage-telemetry/src/recorder.js';

import { probePgTest } from './_helpers/pgTestDb.js';

/**
 * #1393 / #1396 — what a breakdown row is made of, and which day a late call
 * belongs to, against a real `token_usage` table (own schema, so the seed does
 * not disturb usageDashboard.pg.test.ts):
 *  - rows carry cache-write tokens, not only cache reads;
 *  - every `sub-agent builder-<draftId>` folds into one row;
 *  - "By source" ends in one "Other" row after the top ten;
 *  - a call at 23:30 UTC lands on the next day in Europe/Berlin.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'usageDashboardBreakdown',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
});

const SCHEMA = 'c03_usage_breakdown';
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

function row(source: string, costUsd: number, at: string, extra: Partial<Parameters<typeof recordUsage>[0]> = {}): void {
  recordUsage({
    source,
    model: 'claude-sonnet-5-5',
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd,
    occurredAt: new Date(at),
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
  // Three builder drafts, one with two rows.
  row('sub-agent builder-aaaa', 1, '2026-03-02T10:00:00Z', { cacheCreationTokens: 500 });
  row('sub-agent builder-aaaa', 1, '2026-03-02T10:05:00Z', { cacheCreationTokens: 300 });
  row('sub-agent builder-bbbb', 2, '2026-03-02T11:00:00Z');
  row('sub-agent builder-cccc', 3, '2026-03-02T12:00:00Z');
  // Twelve ordinary sources, costs 0.12 … 0.01 — the last two are the tail.
  for (let i = 1; i <= 12; i += 1) {
    row(`source-${String(i).padStart(2, '0')}`, (13 - i) / 100, '2026-03-02T13:00:00Z');
  }
  // The issue's case: 23:30 UTC on 2 March is 00:30 on 3 March in Berlin.
  row('late', 0.001, '2026-03-02T23:30:00Z');
  await flush();
  const seeded = await pool.query<{ n: string }>('SELECT count(*) AS n FROM token_usage');
  assert.equal(Number(seeded.rows[0]?.n), 17, 'the recorder wrote every seed row');
});

after(async () => {
  await shutdownUsageRecorder();
  await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await pool?.end().catch(() => undefined);
});

describe('#1393 — breakdown rows explain their cost', () => {
  it('folds every builder draft into one row and reports its cache writes', { skip }, async () => {
    const { bySource } = await getUsageDashboard(pool!, {}, 'day');
    const builder = bySource.find((r) => r.key === BUILDER_SOURCE_KEY);
    assert.ok(builder, 'one builder row');
    assert.equal(builder.group, 'builder');
    assert.equal(builder.members, 3);
    assert.equal(builder.calls, 4);
    assert.equal(builder.costUsd, 7);
    assert.equal(builder.cacheCreationTokens, 800);
    assert.equal(bySource.filter((r) => r.key.startsWith('sub-agent builder-')).length, 0);
    assert.equal(bySource[0]?.key, BUILDER_SOURCE_KEY, 'ordered by cost');
  });

  it('shows the top ten sources and folds the rest into one Other row', { skip }, async () => {
    const { bySource } = await getUsageDashboard(pool!, {}, 'day');
    // builder + source-01..09 = 10 rows, then Other = source-10..12 + late.
    assert.equal(bySource.length, 11);
    const other = bySource[10];
    assert.equal(other?.key, OTHER_SOURCE_KEY);
    assert.equal(other?.group, 'other');
    assert.equal(other?.members, 4);
    assert.equal(other?.calls, 4);
    assert.ok(Math.abs((other?.costUsd ?? 0) - 0.061) < 1e-9);
    assert.equal(bySource.slice(0, 10).some((r) => r.group === 'other'), false);
  });

  it('carries cache writes on By model rows too', { skip }, async () => {
    const { byModel } = await getUsageDashboard(pool!, {}, 'day');
    assert.equal(byModel[0]?.cacheCreationTokens, 800);
    assert.equal(byModel[0]?.group, undefined);
  });
});

describe('#1396 — a late call belongs to the next local day', () => {
  it('puts a 23:30 UTC call on the next day in Europe/Berlin', { skip }, async () => {
    const window = { since: '2026-03-02T00:00:00Z', until: '2026-03-03T12:00:00Z' };
    const utc = await getUsageDashboard(pool!, window, 'day', 'UTC');
    assert.deepEqual(
      utc.timeSeries.map((b) => [b.bucket, b.calls]),
      [
        ['2026-03-02T00:00:00.000Z', 17],
        ['2026-03-03T00:00:00.000Z', 0],
      ],
    );
    const berlin = await getUsageDashboard(pool!, window, 'day', 'Europe/Berlin');
    // `since` floors to 2 March 00:00 Berlin (1 March 23:00Z).
    assert.deepEqual(
      berlin.timeSeries.map((b) => [b.bucket, b.calls]),
      [
        ['2026-03-01T23:00:00.000Z', 16],
        ['2026-03-02T23:00:00.000Z', 1],
      ],
    );
  });
});

describe('#1396 — hourly buckets across a DST change', () => {
  it('gives one bucket per real hour key on spring-forward (no duplicate instants)', { skip }, async () => {
    // Europe/Berlin, 29 March 2026: local 02:00 does not exist.
    const { timeSeries } = await getUsageDashboard(
      pool!,
      { since: '2026-03-28T23:00:00Z', until: '2026-03-29T03:30:00Z' },
      'hour',
      'Europe/Berlin',
    );
    const keys = timeSeries.map((b) => b.bucket);
    assert.equal(new Set(keys).size, keys.length, 'bucket keys are unique');
    assert.deepEqual(keys, [
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-29T02:00:00.000Z',
      '2026-03-29T03:00:00.000Z',
    ]);
  });
});

describe('#1393 — capByKey', () => {
  const r = (key: string, costUsd: number): UsageByKey => ({
    key,
    calls: 1,
    costUsd,
    referenceCostUsd: 0,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 2,
  });

  it('leaves short lists alone, including a tail of exactly one', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => r(`k${i}`, 11 - i));
    assert.deepEqual(capByKey(eleven), eleven);
  });

  it('counts a folded builder row in the tail as one source', () => {
    const rows = Array.from({ length: 12 }, (_, i) => r(`k${i}`, 12 - i));
    rows[11] = { ...r('sub-agent builder', 0.5), group: 'builder', members: 9 };
    assert.equal(capByKey(rows)[10]?.members, 2);
  });

  it('sums every field of the tail into the Other row', () => {
    const rows = Array.from({ length: 13 }, (_, i) => r(`k${i}`, 13 - i));
    const capped = capByKey(rows);
    assert.equal(capped.length, 11);
    assert.deepEqual(capped[10], {
      key: OTHER_SOURCE_KEY,
      group: 'other',
      members: 3,
      calls: 3,
      costUsd: 3 + 2 + 1,
      referenceCostUsd: 0,
      inputTokens: 3,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 6,
    });
  });
});
