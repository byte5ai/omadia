import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { startEmbeddingBackfill } from '@omadia/knowledge-graph-neon/dist/embeddingBackfill.js';

/**
 * #440 — the backfill sweep is what makes the model gate recoverable:
 * `processes.embedding` (the second governed cosine space) gets a re-embed
 * path, and a stale-vector clear the gate capped at activation time is
 * finished here rather than in one unbounded boot-time UPDATE.
 */

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

interface ProcessRow {
  id: string;
  title: string;
  steps: unknown;
}

interface Script {
  clearPending?: boolean;
  /** Rows the `processes` pending query can return, in `updated_at` order. */
  pendingProcesses?: ReadonlyArray<ProcessRow>;
  /** Non-NULL vectors per governed column, drained batch by batch. */
  vectorRows?: Record<string, number>;
}

function makeFakePool(script: Script): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const vectors: Record<string, number> = { ...(script.vectorRows ?? {}) };
  const embedded = new Set<string>();

  const driverQuery = (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): QueryResult => {
    queries.push({ sql, params: params ?? [] });
    const result = (
      rows: ReadonlyArray<Record<string, unknown>>,
      rowCount?: number,
    ): QueryResult =>
      ({
        command: '',
        rowCount: rowCount ?? rows.length,
        oid: 0,
        rows: [...rows],
        fields: [],
      }) as unknown as QueryResult;

    const limitOf = (): number => {
      const m = /LIMIT (\d+)/.exec(sql);
      if (m?.[1] !== undefined) return Number(m[1]);
      // `LIMIT $2` — the pending-process query binds its limit.
      return Number(params?.[1] ?? 0);
    };

    if (/pg_try_advisory_lock/i.test(sql)) return result([{ locked: true }]);
    if (/pg_advisory_unlock/i.test(sql)) return result([]);
    if (/SELECT clear_pending/i.test(sql)) {
      return result([{ clear_pending: script.clearPending === true }]);
    }
    if (/SELECT 1 AS residual/i.test(sql)) {
      const table = /FROM (\w+)/.exec(sql)?.[1] ?? '';
      const left = /embedding_attempts > 0/.test(sql) ? 0 : (vectors[table] ?? 0);
      return result(left > 0 ? [{ residual: 1 }] : []);
    }
    if (/SELECT id, title, steps/i.test(sql)) {
      // Mirror the real predicates: NULL embedding, not in the excluded set,
      // oldest first, LIMIT applied LAST — which is the whole point of the
      // exclusion living in SQL rather than in a post-filter.
      const excluded = new Set((params?.[2] as string[] | undefined) ?? []);
      const rows = (script.pendingProcesses ?? []).filter(
        (r) => !embedded.has(r.id) && !excluded.has(r.id),
      );
      return result(rows.slice(0, limitOf()) as unknown as Record<string, unknown>[]);
    }
    if (/^\s*UPDATE processes/i.test(sql)) {
      if (/::vector/.test(sql)) {
        embedded.add(String(params?.[2] ?? ''));
        return result([], 1);
      }
      const n = Math.min(vectors['processes'] ?? 0, limitOf());
      vectors['processes'] = (vectors['processes'] ?? 0) - n;
      return result([], n);
    }
    if (/^\s*UPDATE graph_nodes/i.test(sql)) {
      if (/embedding_attempts > 0/.test(sql)) return result([], 0);
      const n = Math.min(vectors['graph_nodes'] ?? 0, limitOf());
      vectors['graph_nodes'] = (vectors['graph_nodes'] ?? 0) - n;
      return result([], n);
    }
    return result([], 0);
  };

  const pool = {
    async query(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<QueryResult> {
      return driverQuery(sql, params);
    },
    async connect(): Promise<PoolClient> {
      return {
        async query(
          sql: string,
          params?: ReadonlyArray<unknown>,
        ): Promise<QueryResult> {
          return driverQuery(sql, params);
        },
        release(): void {
          /* no-op */
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;

  return { pool, queries };
}

const silent = (): void => undefined;

function embedder(vector: number[]): { embed: () => Promise<number[]> } {
  return { embed: async (): Promise<number[]> => vector };
}

/** Embeds everything except texts containing a poisoned marker. */
function selectiveEmbedder(poisonMarkers: ReadonlyArray<string>): {
  embed: (text: string) => Promise<number[]>;
} {
  return {
    embed: async (text: string): Promise<number[]> => {
      if (poisonMarkers.some((marker) => text.includes(marker))) {
        throw new Error('embedder is down for this row');
      }
      return [0.1];
    },
  };
}

describe('embedding backfill — processes + stale-vector clear (#440)', () => {
  it('re-embeds processes whose vector the model gate cleared', async () => {
    const { pool, queries } = makeFakePool({
      pendingProcesses: [
        { id: 'process:ops:deploy', title: 'Ops: Deploy', steps: ['a', 'b'] },
      ],
    });

    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: embedder([0.1, 0.2, 0.3]),
      tenantId: 't1',
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      includeProcesses: true,
      log: silent,
    });
    const stats = await handle.runOnce();
    handle.stop();

    assert.equal(stats.succeeded, 1);
    const write = queries.find((q) => /^\s*UPDATE processes/i.test(q.sql));
    assert.ok(write, 'expected the process vector to be written back');
    assert.deepEqual(write.params, ['[0.1,0.2,0.3]', 't1', 'process:ops:deploy']);
  });

  it('leaves processes alone unless the caller opts in', async () => {
    const { pool, queries } = makeFakePool({
      pendingProcesses: [
        { id: 'process:ops:deploy', title: 'Ops: Deploy', steps: ['a'] },
      ],
    });

    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: embedder([0.1]),
      tenantId: 't1',
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      log: silent,
    });
    await handle.runOnce();
    handle.stop();

    assert.ok(!queries.some((q) => /FROM processes/i.test(q.sql)));
  });

  it('excludes poisoned rows in SQL so healthy ones behind them stay reachable', async () => {
    // The starvation case: `batchSize` rows that always fail sit at the front
    // of the `updated_at` order. Filtering AFTER the LIMIT means every tick
    // returns exactly those rows, the filter empties the list, and the healthy
    // rows behind them are never embedded for the lifetime of the handle.
    const { pool, queries } = makeFakePool({
      pendingProcesses: [
        { id: 'process:a:one', title: 'A: One', steps: ['POISON-one'] },
        { id: 'process:a:two', title: 'A: Two', steps: ['POISON-two'] },
        { id: 'process:b:healthy', title: 'B: Healthy', steps: ['fine'] },
      ],
    });

    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: selectiveEmbedder(['POISON']),
      tenantId: 't1',
      intervalMs: 60_000,
      // batchSize == the number of poison rows: with a post-LIMIT filter the
      // healthy row could never appear in a result page.
      batchSize: 2,
      maxAttempts: 1,
      includeProcesses: true,
      log: silent,
    });
    await handle.runOnce(); // burns both poison rows' single attempt
    const second = await handle.runOnce();
    handle.stop();

    const pendingQueries = queries.filter((q) => /SELECT id, title, steps/i.test(q.sql));
    assert.ok(pendingQueries.length >= 2);
    const last = pendingQueries[pendingQueries.length - 1];
    assert.match(
      last.sql,
      /id <> ALL/,
      'the exclusion has to happen before the LIMIT, i.e. in SQL',
    );
    assert.deepEqual(
      last.params[2],
      ['process:a:one', 'process:a:two'],
      'exhausted ids are handed to the query, not filtered out afterwards',
    );
    assert.equal(second.succeeded, 1, 'the healthy row is finally reachable');
    const write = queries.find(
      (q) => /^\s*UPDATE processes/i.test(q.sql) && q.params[2] === 'process:b:healthy',
    );
    assert.ok(write, 'expected the healthy process to be embedded');
  });

  it('finishes a pending stale-vector clear instead of embedding', async () => {
    const { pool, queries } = makeFakePool({
      clearPending: true,
      vectorRows: { graph_nodes: 3, processes: 3 },
      pendingProcesses: [
        { id: 'process:ops:deploy', title: 'Ops: Deploy', steps: ['a'] },
      ],
    });

    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: embedder([0.1]),
      tenantId: 't1',
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      includeProcesses: true,
      resumeStaleVectorClear: true,
      log: silent,
    });
    const stats = await handle.runOnce();
    handle.stop();

    // 3 rows per column, two governed columns.
    assert.equal(stats.cleared, 6);
    assert.equal(stats.tried, 0);
    assert.ok(
      !queries.some((q) => /SELECT id, title, steps/i.test(q.sql)),
      'nothing may be re-embedded while stale vectors are still around — ' +
        'the clear relies on "non-NULL means old model"',
    );
    assert.ok(
      queries.some((q) => /clear_pending = FALSE/i.test(q.sql)),
      'a finished clear lowers the flag so the next tick embeds again',
    );
  });

  it('reports a clear it found ALREADY down, so a dropped report cannot wedge the gate', async () => {
    // LIVENESS. `markStaleVectorClearComplete` drops a report whose epoch is
    // not the one that armed the CURRENT owed clear. A tick that captured
    // epoch N can physically drain the flag a SECOND switch armed under N+1:
    // its report carries N and is dropped, and if only the draining tick ever
    // reported, no later tick would report at all — the flag is down for every
    // one of them. /health would keep `stale-vector-clear-pending` and vector
    // writes would stay refused until a restart or another switch.
    const { pool } = makeFakePool({
      clearPending: false,
      pendingProcesses: [
        { id: 'process:ops:deploy', title: 'Ops: Deploy', steps: ['a'] },
      ],
    });
    const reported: number[] = [];

    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: embedder([0.1]),
      tenantId: 't1',
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      includeProcesses: true,
      resumeStaleVectorClear: true,
      gateEpoch: () => 7,
      onStaleVectorClearComplete: (epoch) => {
        reported.push(epoch);
      },
      log: silent,
    });
    const stats = await handle.runOnce();
    handle.stop();

    assert.deepEqual(
      reported,
      [7],
      'the tick observed the flag FALSE under the CURRENT epoch, which is ' +
        'exactly the fact the publication needs to re-open writes',
    );
    assert.equal(stats.succeeded, 1, 'and the tick still does its normal work');
  });

  it('does not lower the flag while the clear still owes rows', async () => {
    const { pool, queries } = makeFakePool({
      clearPending: true,
      // Far more than batchSize * STALE_CLEAR_BATCHES_PER_SWEEP (10 * 10).
      vectorRows: { graph_nodes: 5_000, processes: 5_000 },
    });

    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: embedder([0.1]),
      tenantId: 't1',
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      includeProcesses: true,
      resumeStaleVectorClear: true,
      log: silent,
    });
    const stats = await handle.runOnce();
    handle.stop();

    assert.equal(stats.cleared, 200, 'capped at maxRows per column, two columns');
    assert.ok(
      !queries.some((q) => /clear_pending = FALSE/i.test(q.sql)),
      'an unfinished clear must keep the flag raised for the next tick',
    );
  });

  it('announces a drained clear so the published gate status can catch up', async () => {
    // The gate publishes its verdict once, at activation. Nothing else knows
    // when the clear actually finishes, so /health would keep reporting
    // `stale-vector-clear-pending` until the next restart.
    const { pool } = makeFakePool({
      clearPending: true,
      vectorRows: { graph_nodes: 3, processes: 3 },
    });
    let announced = 0;

    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: embedder([0.1]),
      tenantId: 't1',
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      includeProcesses: true,
      resumeStaleVectorClear: true,
      onStaleVectorClearComplete: () => {
        announced++;
      },
      log: silent,
    });
    await handle.runOnce();
    handle.stop();

    assert.equal(announced, 1);
  });

  it('stays silent while the clear still owes rows', async () => {
    const { pool } = makeFakePool({
      clearPending: true,
      vectorRows: { graph_nodes: 5_000, processes: 5_000 },
    });
    let announced = 0;

    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: embedder([0.1]),
      tenantId: 't1',
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      includeProcesses: true,
      resumeStaleVectorClear: true,
      onStaleVectorClearComplete: () => {
        announced++;
      },
      log: silent,
    });
    await handle.runOnce();
    handle.stop();

    assert.equal(
      announced,
      0,
      'announcing a clear that still owes rows would re-enable the false-green reading',
    );
  });

  it('survives a listener that throws', async () => {
    const { pool, queries } = makeFakePool({
      clearPending: true,
      vectorRows: { graph_nodes: 1, processes: 1 },
    });

    const handle = startEmbeddingBackfill({
      pool,
      embeddingClient: embedder([0.1]),
      tenantId: 't1',
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      includeProcesses: true,
      resumeStaleVectorClear: true,
      onStaleVectorClearComplete: () => {
        throw new Error('listener blew up');
      },
      log: silent,
    });
    const stats = await handle.runOnce();
    handle.stop();

    assert.equal(stats.cleared, 2, 'the clear itself still counts');
    assert.ok(queries.some((q) => /clear_pending = FALSE/i.test(q.sql)));
  });
});
