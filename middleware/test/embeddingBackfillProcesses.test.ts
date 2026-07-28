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

interface Script {
  clearPending?: boolean;
  pendingProcesses?: ReadonlyArray<{ id: string; title: string; steps: unknown }>;
  clearedPerBatch?: number;
}

function makeFakePool(script: Script): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];

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

    if (/SELECT clear_pending/i.test(sql)) {
      return result([{ clear_pending: script.clearPending === true }]);
    }
    if (/SELECT id, title, steps/i.test(sql)) {
      return result([...(script.pendingProcesses ?? [])]);
    }
    if (/^\s*UPDATE (graph_nodes|processes)/i.test(sql)) {
      return result([], script.clearedPerBatch ?? 0);
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

  it('finishes a pending stale-vector clear instead of embedding', async () => {
    const { pool, queries } = makeFakePool({
      clearPending: true,
      clearedPerBatch: 3,
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
});
