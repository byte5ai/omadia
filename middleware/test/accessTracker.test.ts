import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, QueryResult } from 'pg';

import { AccessTracker } from '@omadia/knowledge-graph-neon/dist/accessTracker.js';

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function makeFakePool(opts: {
  /** Sequence of rowCount values for the UPDATE statement (the COUNT
   *  query is mocked separately). */
  updateRowCounts?: ReadonlyArray<number>;
  /** Sequence of COUNT(*) values for the cold-precount SELECT. */
  coldCounts?: ReadonlyArray<number>;
  throwOnUpdate?: boolean;
}): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  let updateIdx = 0;
  let coldIdx = 0;
  const updateCounts = opts.updateRowCounts ?? [];
  const coldCounts = opts.coldCounts ?? [];

  const pool = {
    async query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
      queries.push({ sql, params: params ?? [] });
      const isCount = /SELECT\s+COUNT\(/i.test(sql);
      if (isCount) {
        const c = coldCounts[coldIdx] ?? 0;
        coldIdx += 1;
        return {
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          rows: [{ count: String(c) }],
          fields: [],
        } as unknown as QueryResult;
      }
      // UPDATE branch
      if (opts.throwOnUpdate) {
        throw new Error('scripted-update-throw');
      }
      const rc = updateCounts[updateIdx] ?? 0;
      updateIdx += 1;
      return {
        command: 'UPDATE',
        rowCount: rc,
        oid: 0,
        rows: [],
        fields: [],
      } as unknown as QueryResult;
    },
  } as unknown as Pool;

  return { pool, queries };
}

describe('AccessTracker', () => {
  it('coalesces repeated marks for the same external_id into one entry', () => {
    const tracker = new AccessTracker({ log: () => {} });
    tracker.markAccessed('turn:demo:a');
    tracker.markAccessed('turn:demo:a');
    tracker.markAccessed('turn:demo:a');
    tracker.markAccessed('turn:demo:b');
    assert.equal(tracker.pendingCount(), 2);
  });

  it('ignores null/undefined/empty external_ids defensively', () => {
    const tracker = new AccessTracker({ log: () => {} });
    tracker.markAccessed(null);
    tracker.markAccessed(undefined);
    tracker.markAccessed('');
    tracker.markAccessed('turn:demo:a');
    assert.equal(tracker.pendingCount(), 1);
  });

  it('flush() is a noop when nothing was tracked', async () => {
    const tracker = new AccessTracker({ log: () => {} });
    const { pool, queries } = makeFakePool({});
    const stats = await tracker.flush({ pool, tenantId: 't' });
    assert.equal(stats.flushed, 0);
    assert.equal(stats.promotedColdToWarm, 0);
    assert.equal(queries.length, 0);
  });

  it('flush() runs cold-precount + UPDATE with correct params + clears the map', async () => {
    const tracker = new AccessTracker({ log: () => {} });
    tracker.markAccessed('turn:demo:a');
    tracker.markAccessed('turn:demo:a'); // delta=2
    tracker.markAccessed('turn:demo:b');
    const { pool, queries } = makeFakePool({
      coldCounts: [1],
      updateRowCounts: [2],
    });

    const stats = await tracker.flush({ pool, tenantId: 'tenant-x' });

    assert.equal(stats.flushed, 2);
    assert.equal(stats.promotedColdToWarm, 1);
    assert.equal(tracker.pendingCount(), 0, 'map must be drained on success');
    assert.equal(queries.length, 2);

    // Phase 1 — cold-precount SELECT.
    const countSql = queries[0]?.sql ?? '';
    assert.ok(/SELECT\s+COUNT\(/i.test(countSql));
    assert.ok(/tier = 'COLD'/.test(countSql));
    assert.equal(queries[0]?.params[0], 'tenant-x');
    assert.deepEqual(queries[0]?.params[1], ['turn:demo:a', 'turn:demo:b']);

    // Phase 2 — UPDATE with UNNEST + 3 arrays.
    const updateSql = queries[1]?.sql ?? '';
    assert.ok(/UPDATE\s+graph_nodes/i.test(updateSql));
    assert.ok(/access_count = n.access_count \+ u.delta/.test(updateSql));
    assert.ok(/CASE WHEN n.tier = 'COLD' THEN 'WARM'/.test(updateSql));
    assert.ok(/UNNEST\(\$2::text\[\], \$3::int\[\], \$4::timestamptz\[\]\)/.test(updateSql));
    assert.equal(queries[1]?.params[0], 'tenant-x');
    assert.deepEqual(queries[1]?.params[1], ['turn:demo:a', 'turn:demo:b']);
    assert.deepEqual(queries[1]?.params[2], [2, 1]); // deltas in same order
    const lastAccess = queries[1]?.params[3] as ReadonlyArray<string>;
    assert.equal(lastAccess.length, 2);
    assert.ok(lastAccess.every((iso) => /^\d{4}-\d{2}-\d{2}T/.test(iso)));
  });

  it('flush() rethrows + clears the map on UPDATE failure (no double-count next tick)', async () => {
    const tracker = new AccessTracker({ log: () => {} });
    tracker.markAccessed('turn:demo:a');
    const { pool } = makeFakePool({
      coldCounts: [0],
      throwOnUpdate: true,
    });

    await assert.rejects(
      () => tracker.flush({ pool, tenantId: 't' }),
      /scripted-update-throw/,
    );
    // Map was already drained BEFORE the await — accepted trade-off:
    // lose one tick's deltas rather than risk double-counts on retry.
    assert.equal(tracker.pendingCount(), 0);
  });
});
