import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';

// ---------------------------------------------------------------------------
// FakePool — captures queries (pool + transactional client). Extends the
// pattern from agentPrioritiesStore.test.ts to support `pool.connect()`
// because `edit` opens a transactional client.
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
  /** 'pool' for pool.query, 'client' for transactional client.query. */
  via: 'pool' | 'client';
}

function makeFakePool(opts: {
  /** Rows returned for SELECT-like queries, in arrival order. */
  rowsScript?: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
}): {
  pool: Pool;
  queries: CapturedQuery[];
  released: { count: number };
} {
  const queries: CapturedQuery[] = [];
  const rowsScript = opts.rowsScript ?? [];
  let scriptIndex = 0;
  const released = { count: 0 };

  const driverQuery = (
    via: 'pool' | 'client',
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): QueryResult => {
    queries.push({ sql, params: params ?? [], via });
    const wantsRows = /(^\s*SELECT|^\s*WITH|RETURNING)/i.test(sql);
    const rows = wantsRows ? (rowsScript[scriptIndex] ?? []) : [];
    if (wantsRows) scriptIndex += 1;
    return {
      command: '',
      rowCount: rows.length,
      oid: 0,
      rows: [...rows],
      fields: [],
    } as unknown as QueryResult;
  };

  const pool = {
    async query(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<QueryResult> {
      return driverQuery('pool', sql, params);
    },
    async connect(): Promise<PoolClient> {
      const client = {
        async query(
          sql: string,
          params?: ReadonlyArray<unknown>,
        ): Promise<QueryResult> {
          return driverQuery('client', sql, params);
        },
        release(): void {
          released.count += 1;
        },
      } as unknown as PoolClient;
      return client;
    },
  } as unknown as Pool;

  return { pool, queries, released };
}

function makeFakeEmbeddingClient(vector: number[] = [0.1, 0.2, 0.3]): {
  embed: (text: string) => Promise<number[]>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async embed(text: string): Promise<number[]> {
      calls.push(text);
      return [...vector];
    },
  };
}

describe('NeonProcessMemoryStore', () => {
  describe('write', () => {
    it('rejects non-conforming title with reason=invalid-title', async () => {
      const { pool } = makeFakePool({});
      const embed = makeFakeEmbeddingClient();
      const store = new NeonProcessMemoryStore({
        pool,
        tenantId: 'tenant-test',
        embeddingClient: embed,
      });
      const result = await store.write({
        title: 'lowercase no colon',
        steps: ['a'],
        scope: 's',
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.reason, 'invalid-title');
      // No embedding call when title fails.
      assert.equal(embed.calls.length, 0);
    });

    it('rejects when no embeddingClient configured (embedding-unavailable)', async () => {
      const { pool, queries } = makeFakePool({});
      const store = new NeonProcessMemoryStore({
        pool,
        tenantId: 'tenant-test',
      });
      const result = await store.write({
        title: 'Backend: Deploy to staging',
        steps: ['Step one'],
        scope: 's',
      });
      assert.equal(result.ok, false);
      assert.equal(
        result.ok ? '' : result.reason,
        'embedding-unavailable',
      );
      // No SQL when embedding-unavailable.
      assert.equal(queries.length, 0);
    });

    it('blocks duplicates above threshold and returns conflictingId', async () => {
      const { pool, queries } = makeFakePool({
        rowsScript: [
          // dedup-query returns one row above threshold
          [
            {
              id: 'process:s:backend-deploy-to-staging',
              title: 'Backend: Deploy to staging',
              similarity: '0.95',
            },
          ],
        ],
      });
      const embed = makeFakeEmbeddingClient();
      const store = new NeonProcessMemoryStore({
        pool,
        tenantId: 'tenant-test',
        embeddingClient: embed,
      });
      const result = await store.write({
        title: 'Backend: Push to staging',
        steps: ['fly deploy'],
        scope: 's',
      });
      assert.equal(result.ok, false);
      if (result.ok) throw new Error('unreachable');
      assert.equal(result.reason, 'duplicate');
      if (result.reason !== 'duplicate') throw new Error('unreachable');
      assert.equal(result.conflictingId, 'process:s:backend-deploy-to-staging');
      assert.equal(result.conflictingTitle, 'Backend: Deploy to staging');
      assert.ok(Math.abs(result.similarity - 0.95) < 1e-6);
      // 1 dedup SELECT, NO INSERT.
      assert.equal(queries.length, 1);
      assert.ok(/processes/i.test(queries[0]!.sql));
    });

    it('inserts with deterministic id when no duplicate, returns ProcessRecord', async () => {
      const created = new Date('2026-05-08T12:00:00.000Z');
      const { pool, queries } = makeFakePool({
        rowsScript: [
          [], // empty dedup result
          [
            {
              id: 'process:s:backend-deploy-to-staging',
              scope: 's',
              title: 'Backend: Deploy to staging',
              steps: ['Build', 'Test', 'Deploy'],
              visibility: 'team',
              version: 1,
              created_at: created,
              updated_at: created,
            },
          ],
        ],
      });
      const embed = makeFakeEmbeddingClient();
      const store = new NeonProcessMemoryStore({
        pool,
        tenantId: 'tenant-test',
        embeddingClient: embed,
      });
      const result = await store.write({
        title: 'Backend: Deploy to staging',
        steps: ['Build', 'Test', 'Deploy'],
        scope: 's',
      });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error('unreachable');
      assert.equal(result.record.id, 'process:s:backend-deploy-to-staging');
      assert.equal(result.record.version, 1);
      assert.deepEqual([...result.record.steps], ['Build', 'Test', 'Deploy']);
      assert.equal(result.record.visibility, 'team');
      assert.equal(result.record.createdAt, '2026-05-08T12:00:00.000Z');
      // 1 dedup SELECT + 1 INSERT
      assert.equal(queries.length, 2);
      assert.ok(/INSERT INTO processes/i.test(queries[1]!.sql));
      // INSERT params include tenant + scope + body + steps json + visibility + vector lit.
      const insertParams = queries[1]!.params;
      assert.equal(insertParams[0], 'process:s:backend-deploy-to-staging');
      assert.equal(insertParams[1], 'tenant-test');
      assert.equal(insertParams[2], 's');
      assert.equal(insertParams[5], 'team');
    });
  });

  describe('edit', () => {
    it('returns not-found when row does not exist', async () => {
      const { pool, released } = makeFakePool({
        rowsScript: [
          // BEGIN does not return rows; SELECT … FOR UPDATE returns []
          [],
        ],
      });
      const store = new NeonProcessMemoryStore({
        pool,
        tenantId: 'tenant-test',
        embeddingClient: makeFakeEmbeddingClient(),
      });
      const result = await store.edit({
        id: 'process:s:does-not-exist',
        visibility: 'private',
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.reason, 'not-found');
      // client must be released
      assert.equal(released.count, 1);
    });

    it('snapshots history-row before UPDATE and bumps version', async () => {
      const created = new Date('2026-05-08T12:00:00.000Z');
      const updated = new Date('2026-05-08T13:00:00.000Z');
      const { pool, queries } = makeFakePool({
        rowsScript: [
          // SELECT FOR UPDATE → existing row
          [
            {
              id: 'process:s:backend-deploy-to-staging',
              scope: 's',
              title: 'Backend: Deploy to staging',
              steps: ['Build', 'Test'],
              visibility: 'team',
              version: 3,
              created_at: created,
              updated_at: created,
            },
          ],
          // UPDATE … RETURNING → new row
          [
            {
              id: 'process:s:backend-deploy-to-staging',
              scope: 's',
              title: 'Backend: Deploy to staging',
              steps: ['Build', 'Test', 'Deploy'],
              visibility: 'team',
              version: 4,
              created_at: created,
              updated_at: updated,
            },
          ],
        ],
      });
      const store = new NeonProcessMemoryStore({
        pool,
        tenantId: 'tenant-test',
        embeddingClient: makeFakeEmbeddingClient(),
      });
      const result = await store.edit({
        id: 'process:s:backend-deploy-to-staging',
        steps: ['Build', 'Test', 'Deploy'],
      });
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error('unreachable');
      assert.equal(result.record.version, 4);

      // Sequence: BEGIN, SELECT FOR UPDATE, INSERT INTO process_history,
      // UPDATE processes RETURNING, COMMIT.
      const sqls = queries.map((q) => q.sql);
      assert.ok(sqls.some((s) => /^\s*BEGIN/i.test(s)), 'expected BEGIN');
      assert.ok(
        sqls.some((s) => /SELECT[\s\S]+FROM processes[\s\S]+FOR UPDATE/i.test(s)),
        'expected SELECT … FOR UPDATE',
      );
      assert.ok(
        sqls.some((s) => /INSERT INTO process_history/i.test(s)),
        'expected history snapshot',
      );
      assert.ok(
        sqls.some((s) => /UPDATE processes/i.test(s) && /version = version \+ 1/i.test(s)),
        'expected version bump',
      );
      assert.ok(sqls.some((s) => /^\s*COMMIT/i.test(s)), 'expected COMMIT');
    });
  });

  describe('query', () => {
    it('runs hybrid SQL with tenant + scope filter and maps hits with score', async () => {
      const created = new Date('2026-05-08T12:00:00.000Z');
      const { pool, queries } = makeFakePool({
        rowsScript: [
          [
            {
              id: 'process:s:backend-deploy-to-staging',
              scope: 's',
              title: 'Backend: Deploy to staging',
              steps: ['Build'],
              visibility: 'team',
              version: 1,
              created_at: created,
              updated_at: created,
              cosine_sim: '0.7',
              bm25_norm: '0.3',
              hybrid_score: '0.55',
            },
          ],
        ],
      });
      const store = new NeonProcessMemoryStore({
        pool,
        tenantId: 'tenant-test',
        embeddingClient: makeFakeEmbeddingClient(),
      });
      const hits = await store.query({ query: 'deploy', scope: 's', limit: 5 });
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.record.id, 'process:s:backend-deploy-to-staging');
      assert.ok(Math.abs(hits[0]!.score - 0.55) < 1e-6);
      assert.equal(queries.length, 1);
      assert.ok(/FROM processes/i.test(queries[0]!.sql));
      // tenant + scope binding
      const params = queries[0]!.params;
      assert.equal(params[1], 'tenant-test');
      assert.equal(params[2], 's');
      assert.equal(params[3], 'deploy');
    });
  });

  describe('history', () => {
    it('returns versions descending with metadata', async () => {
      const t1 = new Date('2026-05-08T11:00:00.000Z');
      const t2 = new Date('2026-05-08T12:00:00.000Z');
      const { pool } = makeFakePool({
        rowsScript: [
          [
            {
              id: 'process:s:x',
              scope: 's',
              title: 'X: v2',
              steps: ['b'],
              visibility: 'team',
              version: 2,
              superseded_at: t2,
            },
            {
              id: 'process:s:x',
              scope: 's',
              title: 'X: v1',
              steps: ['a'],
              visibility: 'team',
              version: 1,
              superseded_at: t1,
            },
          ],
        ],
      });
      const store = new NeonProcessMemoryStore({
        pool,
        tenantId: 'tenant-test',
        embeddingClient: makeFakeEmbeddingClient(),
      });
      const history = await store.history('process:s:x');
      assert.equal(history.length, 2);
      assert.equal(history[0]!.version, 2);
      assert.equal(history[1]!.version, 1);
      assert.equal(history[0]!.title, 'X: v2');
    });
  });
});
