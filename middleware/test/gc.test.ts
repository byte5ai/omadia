import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, QueryResult } from 'pg';

import { runGcSweep } from '@omadia/knowledge-graph-neon/dist/gc.js';

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

interface ScopeRow {
  scope: string;
  turn_count: string;
  total_chars: string;
}

function makeFakePool(opts: {
  /** Rows returned by the per-tenant findOverflowingScopes SELECT. */
  overflowingScopes?: ReadonlyArray<ScopeRow>;
  /** rowCounts for the DELETE statements in order. */
  deleteRowCounts?: ReadonlyArray<number>;
}): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const overflows = opts.overflowingScopes ?? [];
  const deleteCounts = opts.deleteRowCounts ?? [];
  let deleteIdx = 0;

  const pool = {
    async query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
      queries.push({ sql, params: params ?? [] });
      const isSelect = /^\s*SELECT\b/i.test(sql) || /^\s*\n\s*SELECT/i.test(sql);
      if (isSelect && /HAVING\s+COUNT/i.test(sql)) {
        return {
          command: 'SELECT',
          rowCount: overflows.length,
          oid: 0,
          rows: overflows as ScopeRow[],
          fields: [],
        } as unknown as QueryResult;
      }
      // DELETE
      const rc = deleteCounts[deleteIdx] ?? 0;
      deleteIdx += 1;
      return {
        command: 'DELETE',
        rowCount: rc,
        oid: 0,
        rows: [],
        fields: [],
      } as unknown as QueryResult;
    },
  } as unknown as Pool;

  return { pool, queries };
}

describe('runGcSweep', () => {
  const baseOpts = {
    tenantId: 'tenant-x',
    hotMaxEntries: 50,
    maxTotalChars: 500_000,
    typeWeights: { memory: 1.0, process: 2.0, task: 1.5 },
    log: (): void => {},
  };

  it('is a noop when no scope is over quota', async () => {
    const { pool, queries } = makeFakePool({ overflowingScopes: [] });
    const stats = await runGcSweep({ pool, ...baseOpts });
    assert.equal(stats.scopesAffected, 0);
    assert.equal(stats.evictedByCount, 0);
    assert.equal(stats.evictedByChars, 0);
    // Only the discovery SELECT.
    assert.equal(queries.length, 1);
    assert.ok(/HAVING\s+COUNT/i.test(queries[0]?.sql ?? ''));
  });

  it('evicts by COUNT when only the count quota is exceeded', async () => {
    const { pool, queries } = makeFakePool({
      overflowingScopes: [
        { scope: 'http-demo', turn_count: '60', total_chars: '50000' }, // 60 > 50, chars OK
      ],
      deleteRowCounts: [10],
    });
    const stats = await runGcSweep({ pool, ...baseOpts });

    assert.equal(stats.scopesAffected, 1);
    assert.equal(stats.evictedByCount, 10);
    assert.equal(stats.evictedByChars, 0);
    // Discovery + count-DELETE only (no char eviction needed).
    assert.equal(queries.length, 2);

    const deleteSql = queries[1]?.sql ?? '';
    assert.ok(/DELETE FROM graph_nodes/i.test(deleteSql));
    assert.ok(/ORDER BY \(\s*CASE entry_type/.test(deleteSql));
    assert.ok(/decay_score ASC/.test(deleteSql));
    // Excess: 60 - 50 = 10
    assert.equal(queries[1]?.params[5], 10);
    // Type-weights propagate.
    assert.equal(queries[1]?.params[2], 2.0); // process
    assert.equal(queries[1]?.params[3], 1.5); // task
    assert.equal(queries[1]?.params[4], 1.0); // memory
  });

  it('evicts by CHARS when only the char quota is exceeded', async () => {
    const { pool, queries } = makeFakePool({
      overflowingScopes: [
        { scope: 'http-demo', turn_count: '40', total_chars: '900000' },
      ],
      deleteRowCounts: [7],
    });
    const stats = await runGcSweep({ pool, ...baseOpts });
    assert.equal(stats.scopesAffected, 1);
    assert.equal(stats.evictedByCount, 0);
    assert.equal(stats.evictedByChars, 7);
    // Discovery + char-DELETE only.
    assert.equal(queries.length, 2);
    assert.ok(/WITH ranked AS/i.test(queries[1]?.sql ?? ''));
    assert.ok(/cum_chars/.test(queries[1]?.sql ?? ''));
  });

  it('runs both phases when both quotas are exceeded', async () => {
    const { pool, queries } = makeFakePool({
      overflowingScopes: [
        { scope: 'http-busy', turn_count: '120', total_chars: '900000' },
      ],
      deleteRowCounts: [70, 4],
    });
    const stats = await runGcSweep({ pool, ...baseOpts });
    assert.equal(stats.scopesAffected, 1);
    assert.equal(stats.evictedByCount, 70); // 120 - 50
    assert.equal(stats.evictedByChars, 4);
    // Discovery + count-DELETE + char-DELETE.
    assert.equal(queries.length, 3);
  });

  it('iterates multiple overflowing scopes independently', async () => {
    const { pool, queries } = makeFakePool({
      overflowingScopes: [
        { scope: 'a', turn_count: '60', total_chars: '100' },  // count only
        { scope: 'b', turn_count: '20', total_chars: '900000' }, // chars only
        { scope: 'c', turn_count: '80', total_chars: '700000' }, // both
      ],
      deleteRowCounts: [10, 5, 30, 8],
    });
    const stats = await runGcSweep({ pool, ...baseOpts });
    assert.equal(stats.scopesAffected, 3);
    assert.equal(stats.evictedByCount, 40); // 10 + 30
    assert.equal(stats.evictedByChars, 13); // 5 + 8
    // 1 discovery + 4 deletes (a:1, b:1, c:2)
    assert.equal(queries.length, 5);
  });

  it('binds tenantId and scope correctly to each delete', async () => {
    const { pool, queries } = makeFakePool({
      overflowingScopes: [{ scope: 'http-demo', turn_count: '60', total_chars: '0' }],
      deleteRowCounts: [10],
    });
    await runGcSweep({ pool, ...baseOpts });
    // queries[0] = discovery, queries[1] = count-DELETE for http-demo
    assert.equal(queries[1]?.params[0], 'tenant-x');
    assert.equal(queries[1]?.params[1], 'http-demo');
  });
});
