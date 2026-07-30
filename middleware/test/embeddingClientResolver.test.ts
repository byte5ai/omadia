import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';

/**
 * #440 — the stores resolve their embedding client LIVE.
 *
 * Both stores used to capture `embeddingClient` in their constructor. The
 * model/dimension gate hands `undefined` whenever it refuses vector writes, so
 * a boot that was gated could never embed again — an operator restart was the
 * only recovery, including after the stale-vector clear that caused the
 * refusal had finished draining.
 *
 * Two properties are under test here, and they pull in opposite directions:
 *
 *  1. a resolver that returns `undefined` must be INDISTINGUISHABLE from the
 *     old absent client: skip, no error, no attempt-counter burn. The stores
 *     treat "no client" and "the client failed" as different states, and the
 *     backfill's retry cap depends on that distinction;
 *  2. a resolver that STARTS returning a client mid-life must make embedding
 *     resume, on the same instance, with no restart.
 */

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

type RowResponder = (
  sql: string,
  params: ReadonlyArray<unknown>,
) => ReadonlyArray<Record<string, unknown>> | undefined;

function makeFakePool(respond?: RowResponder): {
  pool: Pool;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const run = (sql: string, params: ReadonlyArray<unknown>): QueryResult => {
    queries.push({ sql, params });
    const rows = respond?.(sql, params) ?? [];
    return {
      command: '',
      rowCount: rows.length,
      oid: 0,
      rows: [...rows],
      fields: [],
    } as unknown as QueryResult;
  };
  const pool = {
    async query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
      return run(sql, params ?? []);
    },
    async connect(): Promise<PoolClient> {
      return {
        async query(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult> {
          return run(sql, params ?? []);
        },
        release(): void {
          // nothing to drain in a fake
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool, queries };
}

/** ingestTurn needs an id back from every upsert and an honest answer to the
 *  "does this turn already have a vector?" probe. */
const graphResponder: RowResponder = (sql) => {
  if (/has_embedding/.test(sql)) return [{ has_embedding: false }];
  if (/RETURNING id/.test(sql)) return [{ id: '11111111-1111-1111-1111-111111111111' }];
  return [];
};

function embedder(vector: number[] = [0.1, 0.2, 0.3]): {
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

function throwingEmbedder(): { embed: (text: string) => Promise<number[]> } {
  return {
    async embed(): Promise<number[]> {
      throw new Error('sidecar exploded');
    },
  };
}

const TURN = {
  scope: 'test-scope',
  time: '2026-07-29T10:00:00.000Z',
  userMessage: 'hello',
  assistantAnswer: 'world',
  entityRefs: [],
};

/** `embedAndStoreTurn` is fire-and-forget relative to the ingest transaction,
 *  so the assertion has to give the microtask queue a chance to drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function hasVectorWrite(queries: readonly CapturedQuery[]): boolean {
  return queries.some((q) => /SET\s+embedding\s*=\s*\$1::vector/.test(q.sql));
}

function hasAttemptBump(queries: readonly CapturedQuery[]): boolean {
  return queries.some((q) =>
    /embedding_attempts\s*=\s*embedding_attempts\s*\+\s*1/.test(q.sql),
  );
}

describe('#440 live embedding-client resolver — NeonKnowledgeGraph', () => {
  it('a resolver returning undefined is byte-for-byte the old absent client', async () => {
    const withResolver = makeFakePool(graphResponder);
    await new NeonKnowledgeGraph({
      pool: withResolver.pool,
      tenantId: 't',
      resolveEmbeddingClient: () => undefined,
    }).ingestTurn(TURN);
    await settle();

    const withoutAnything = makeFakePool(graphResponder);
    await new NeonKnowledgeGraph({
      pool: withoutAnything.pool,
      tenantId: 't',
    }).ingestTurn(TURN);
    await settle();

    assert.deepEqual(
      withResolver.queries.map((q) => q.sql),
      withoutAnything.queries.map((q) => q.sql),
      'an unavailable resolver must issue exactly the SQL an unconfigured store issues',
    );
    assert.equal(hasVectorWrite(withResolver.queries), false);
    assert.equal(
      hasAttemptBump(withResolver.queries),
      false,
      'unavailable is a SKIP — burning a retry would starve the backfill for rows that never had a chance',
    );
  });

  it('a resolver that starts returning a client resumes embedding with no restart', async () => {
    const { pool, queries } = makeFakePool(graphResponder);
    const embed = embedder();
    let allowed = false;
    const graph = new NeonKnowledgeGraph({
      pool,
      tenantId: 't',
      resolveEmbeddingClient: () => (allowed ? embed : undefined),
    });

    await graph.ingestTurn(TURN);
    await settle();
    assert.equal(hasVectorWrite(queries), false, 'gated: nothing embedded');
    assert.equal(embed.calls.length, 0);

    // This is what `markStaleVectorClearComplete()` does to the published gate
    // status — the store instance is untouched.
    allowed = true;

    await graph.ingestTurn({ ...TURN, time: '2026-07-29T10:05:00.000Z' });
    await settle();
    assert.equal(hasVectorWrite(queries), true, 'writes resumed on the SAME instance');
    assert.equal(embed.calls.length, 1);
  });

  it('keeps skip and failure apart: a throwing client still burns an attempt', async () => {
    const { pool, queries } = makeFakePool(graphResponder);
    const graph = new NeonKnowledgeGraph({
      pool,
      tenantId: 't',
      resolveEmbeddingClient: () => throwingEmbedder(),
    });
    await graph.ingestTurn(TURN);
    await settle();
    assert.equal(hasVectorWrite(queries), false);
    assert.equal(
      hasAttemptBump(queries),
      true,
      'a client that FAILED is not a client that was absent',
    );
  });

  it('a resolver that throws degrades to unavailable rather than breaking ingest', async () => {
    const { pool, queries } = makeFakePool(graphResponder);
    const graph = new NeonKnowledgeGraph({
      pool,
      tenantId: 't',
      resolveEmbeddingClient: () => {
        throw new Error('gate status unreadable');
      },
    });
    const result = await graph.ingestTurn(TURN);
    await settle();
    assert.ok(result.turnId, 'the committed ingest must not be disturbed');
    assert.equal(hasVectorWrite(queries), false);
    assert.equal(hasAttemptBump(queries), false);
  });
});

const PROCESS_ROW = {
  id: 'p1',
  scope: 's',
  title: 'Backend: Deploy to staging',
  steps: ['Step one'],
  visibility: 'team',
  version: 1,
  created_at: '2026-07-29T10:00:00.000Z',
  updated_at: '2026-07-29T10:00:00.000Z',
};

const processResponder: RowResponder = (sql) => {
  // Dedup pre-check finds nothing.
  if (/1 - \(embedding <=> /.test(sql) && /FROM processes/.test(sql) && /ORDER BY similarity/.test(sql)) {
    return [];
  }
  if (/RETURNING id, scope, title/.test(sql)) return [PROCESS_ROW];
  if (/FOR UPDATE/.test(sql)) return [PROCESS_ROW];
  return [];
};

describe('#440 live embedding-client resolver — NeonProcessMemoryStore', () => {
  it('an undefined resolver rejects exactly like an unconfigured store, with no SQL', async () => {
    const withResolver = makeFakePool(processResponder);
    const a = await new NeonProcessMemoryStore({
      pool: withResolver.pool,
      tenantId: 't',
      resolveEmbeddingClient: () => undefined,
    }).write({ title: 'Backend: Deploy to staging', steps: ['Step one'], scope: 's' });

    const withoutAnything = makeFakePool(processResponder);
    const b = await new NeonProcessMemoryStore({
      pool: withoutAnything.pool,
      tenantId: 't',
    }).write({ title: 'Backend: Deploy to staging', steps: ['Step one'], scope: 's' });

    assert.deepEqual(a, b);
    assert.equal(a.ok, false);
    assert.equal(a.ok ? '' : a.reason, 'embedding-unavailable');
    assert.equal(withResolver.queries.length, 0);
    assert.equal(withoutAnything.queries.length, 0);
  });

  it('resumes accepting writes when the resolver starts handing one out', async () => {
    const { pool } = makeFakePool(processResponder);
    const embed = embedder();
    let allowed = false;
    const store = new NeonProcessMemoryStore({
      pool,
      tenantId: 't',
      resolveEmbeddingClient: () => (allowed ? embed : undefined),
    });
    const input = {
      title: 'Backend: Deploy to staging',
      steps: ['Step one'],
      scope: 's',
    };

    const gated = await store.write(input);
    assert.equal(gated.ok, false);
    assert.equal(gated.ok ? '' : gated.reason, 'embedding-unavailable');

    allowed = true;

    const open = await store.write(input);
    assert.equal(open.ok, true, 'same instance, no restart');
    assert.equal(embed.calls.length, 1);
  });

  it('query degrades to BM25-only under an undefined resolver', async () => {
    const { pool, queries } = makeFakePool(processResponder);
    await new NeonProcessMemoryStore({
      pool,
      tenantId: 't',
      resolveEmbeddingClient: () => undefined,
    }).query({ query: 'deploy', limit: 5 });

    const scored = queries.find((q) => /WITH scored AS/.test(q.sql));
    assert.ok(scored, 'the hybrid query still runs');
    assert.equal(scored.params[0], null, 'with a NULL vector — the BM25 leg only');
  });

  it('edit resolves ONCE: a resolver that goes away mid-transaction cannot break it', async () => {
    const { pool } = makeFakePool(processResponder);
    const embed = embedder();
    let calls = 0;
    const store = new NeonProcessMemoryStore({
      pool,
      tenantId: 't',
      // Available at the availability guard, gone by the time `edit` reaches
      // the embed call. Re-resolving there would throw inside an open
      // transaction instead of returning `embedding-unavailable` cleanly.
      resolveEmbeddingClient: () => {
        calls += 1;
        return calls === 1 ? embed : undefined;
      },
    });

    const result = await store.edit({ id: 'p1', title: 'Backend: Deploy to prod' });
    assert.equal(result.ok, true);
    assert.equal(embed.calls.length, 1);
    assert.equal(calls, 1, 'exactly one resolve for the whole operation');
  });
});
