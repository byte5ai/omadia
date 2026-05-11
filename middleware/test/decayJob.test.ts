import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { runDecaySweep } from '@omadia/knowledge-graph-neon/dist/decayJob.js';

// ---------------------------------------------------------------------------
// FakePool — minimal pg.Pool stand-in that captures SQL+params and returns
// predefined rowCounts. Lets us assert statement ORDER (BEGIN → 3×UPDATE →
// DELETE → COMMIT/ROLLBACK), parameter binding, and tenant-scoping without
// spinning up a real Postgres.
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

interface ScriptedResponse {
  rowCount?: number;
  throwOn?: 'first' | 'second' | 'third' | 'fourth';
}

function makeFakePool(opts: {
  /** rowCount per UPDATE/DELETE statement, in order. Default 0 each. */
  rowCounts?: ReadonlyArray<number>;
  /** Make the n-th non-control statement throw. */
  throwOnStatement?: number;
}): {
  pool: Pool;
  queries: CapturedQuery[];
  released: { count: number };
} {
  const queries: CapturedQuery[] = [];
  const released = { count: 0 };
  const rowCounts = opts.rowCounts ?? [0, 0, 0, 0];
  let dataStmtIndex = 0;

  const client = {
    async query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
      queries.push({ sql, params: params ?? [] });
      const isControl =
        sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK';
      if (!isControl) {
        const here = dataStmtIndex;
        dataStmtIndex += 1;
        if (opts.throwOnStatement !== undefined && here === opts.throwOnStatement) {
          throw new Error(`scripted-throw-on-stmt-${String(here)}`);
        }
        const rc = rowCounts[here] ?? 0;
        return {
          command: '',
          rowCount: rc,
          oid: 0,
          rows: [],
          fields: [],
        } as unknown as QueryResult;
      }
      return {
        command: sql,
        rowCount: 0,
        oid: 0,
        rows: [],
        fields: [],
      } as unknown as QueryResult;
    },
    release(): void {
      released.count += 1;
    },
  } as unknown as PoolClient;

  const pool = {
    async connect(): Promise<PoolClient> {
      return client;
    },
  } as unknown as Pool;

  return { pool, queries, released };
}

describe('runDecaySweep', () => {
  const baseOpts = {
    tenantId: 'tenant-test',
    lambda: 0.05,
    hotToWarmScoreThreshold: 0.5,
    hotToWarmIdleDays: 7,
    warmToColdScoreThreshold: 0.1,
    warmToColdIdleDays: 30,
    doneTaskTtlHours: 24,
    log: (): void => {},
  };

  it('runs 4 data statements between BEGIN and COMMIT in the right order', async () => {
    const { pool, queries, released } = makeFakePool({
      rowCounts: [11, 2, 1, 3],
    });

    const stats = await runDecaySweep({ pool, ...baseOpts });

    // Control flow: BEGIN, 4 data statements, COMMIT.
    assert.equal(queries.length, 6);
    assert.equal(queries[0]?.sql, 'BEGIN');
    assert.equal(queries[5]?.sql, 'COMMIT');

    // Statement 1: decay UPDATE (must reference EXP + LN + access_count).
    const decay = queries[1]?.sql ?? '';
    assert.ok(/UPDATE\s+graph_nodes/i.test(decay));
    assert.ok(/SET\s+decay_score/i.test(decay));
    assert.ok(/EXP\(/.test(decay));
    assert.ok(/LN\(1 \+ access_count\)/.test(decay));
    assert.ok(/type = 'Turn'/.test(decay));

    // Statement 2: HOT → WARM
    const hot = queries[2]?.sql ?? '';
    assert.ok(/SET tier = 'WARM'/.test(hot));
    assert.ok(/tier = 'HOT'/.test(hot));

    // Statement 3: WARM → COLD
    const warm = queries[3]?.sql ?? '';
    assert.ok(/SET tier = 'COLD'/.test(warm));
    assert.ok(/tier = 'WARM'/.test(warm));

    // Statement 4: done-task hard-DELETE
    const done = queries[4]?.sql ?? '';
    assert.ok(/DELETE FROM graph_nodes/i.test(done));
    assert.ok(/entry_type = 'task'/.test(done));
    assert.ok(/task_status = 'done'/.test(done));

    // Aggregated stats reflect rowCounts.
    assert.equal(stats.decayUpdated, 11);
    assert.equal(stats.hotToWarm, 2);
    assert.equal(stats.warmToCold, 1);
    assert.equal(stats.doneTasksDeleted, 3);
    assert.ok(stats.durationMs >= 0);

    // Client must always be released.
    assert.equal(released.count, 1);
  });

  it('binds tenantId as $1 in every data statement', async () => {
    const { pool, queries } = makeFakePool({});
    await runDecaySweep({ pool, ...baseOpts });
    for (const q of queries.slice(1, 5)) {
      assert.equal(q.params[0], 'tenant-test', `tenant must be $1: ${q.sql}`);
    }
  });

  it('passes the configured thresholds + lambda + idle-days into params', async () => {
    const { pool, queries } = makeFakePool({});
    await runDecaySweep({
      pool,
      ...baseOpts,
      lambda: 0.1,
      hotToWarmScoreThreshold: 0.55,
      hotToWarmIdleDays: 14,
      warmToColdScoreThreshold: 0.08,
      warmToColdIdleDays: 45,
      doneTaskTtlHours: 48,
    });

    // Stmt 1 (decay): [tenant, lambda]
    assert.deepEqual(queries[1]?.params, ['tenant-test', 0.1]);
    // Stmt 2 (HOT→WARM): [tenant, hotScoreThreshold, hotIdleDays]
    assert.deepEqual(queries[2]?.params, ['tenant-test', 0.55, 14]);
    // Stmt 3 (WARM→COLD): [tenant, warmScoreThreshold, warmIdleDays]
    assert.deepEqual(queries[3]?.params, ['tenant-test', 0.08, 45]);
    // Stmt 4 (DELETE): [tenant, doneTaskTtlHours]
    assert.deepEqual(queries[4]?.params, ['tenant-test', 48]);
  });

  it('rolls back + rethrows when a statement fails mid-sweep', async () => {
    // Throw on the 3rd data statement (= WARM→COLD).
    const { pool, queries, released } = makeFakePool({
      rowCounts: [10, 1],
      throwOnStatement: 2,
    });

    await assert.rejects(
      () => runDecaySweep({ pool, ...baseOpts }),
      /scripted-throw-on-stmt-2/,
    );

    // Trail: BEGIN, decay, hot, warm-throws, ROLLBACK
    assert.equal(queries[0]?.sql, 'BEGIN');
    assert.equal(queries[queries.length - 1]?.sql, 'ROLLBACK');
    // No COMMIT must have happened.
    assert.ok(!queries.some((q) => q.sql === 'COMMIT'));
    // Client still released.
    assert.equal(released.count, 1);
  });

  it('is idempotent — two consecutive sweeps produce same statement shape', async () => {
    const { pool, queries } = makeFakePool({});
    await runDecaySweep({ pool, ...baseOpts });
    const firstSql = queries.map((q) => q.sql);
    queries.length = 0;
    await runDecaySweep({ pool, ...baseOpts });
    const secondSql = queries.map((q) => q.sql);
    assert.deepEqual(firstSql, secondSql);
  });
});
