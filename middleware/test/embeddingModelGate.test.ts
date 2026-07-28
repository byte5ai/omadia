import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  allowsVectorWrites,
  evaluateEmbeddingModelGate,
} from '@omadia/knowledge-graph-neon/dist/embeddingModelGate.js';

// ---------------------------------------------------------------------------
// FakePool — the gate issues at most two pool selects plus one transactional
// update pair, so a scripted-rows pool (same pattern as
// processMemoryStore.test.ts) is enough.
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function makeFakePool(
  rowsScript: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
  updateRowCount = 0,
): { pool: Pool; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  let scriptIndex = 0;

  const driverQuery = (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): QueryResult => {
    queries.push({ sql, params: params ?? [] });
    const wantsRows = /^\s*SELECT/i.test(sql);
    const rows = wantsRows ? (rowsScript[scriptIndex] ?? []) : [];
    if (wantsRows) scriptIndex += 1;
    return {
      command: '',
      rowCount: wantsRows ? rows.length : updateRowCount,
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

const OLLAMA = { modelId: 'ollama:nomic-embed-text', dimensions: 768 };
const OPENAI_SMALL = { modelId: 'openai:text-embedding-3-small', dimensions: 1536 };
const OTHER_768 = { modelId: 'openai:some-768-model', dimensions: 768 };

const silent = (): void => undefined;

describe('evaluateEmbeddingModelGate', () => {
  it('allows writes and records nothing when the provider has no metadata', async () => {
    const { pool, queries } = makeFakePool([]);

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: undefined,
      log: silent,
    });

    assert.equal(outcome.status, 'unknown-provider');
    assert.equal(allowsVectorWrites(outcome), true);
    assert.equal(queries.length, 0);
  });

  it('records the active model on a first run with an empty corpus', async () => {
    // no stored model row, no embedded nodes
    const { pool, queries } = makeFakePool([[], []]);

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OLLAMA,
      log: silent,
    });

    assert.equal(outcome.status, 'recorded');
    assert.equal(allowsVectorWrites(outcome), true);
    const insert = queries.find((q) => /INSERT INTO graph_embedding_model/i.test(q.sql));
    assert.ok(insert, 'expected the active model to be persisted');
    assert.deepEqual(insert.params, ['t1', OLLAMA.modelId, OLLAMA.dimensions]);
  });

  it('adopts an unrecorded pre-#440 corpus when the dimensions already match', async () => {
    const { pool, queries } = makeFakePool([[], [{ dims: 768 }]]);

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OLLAMA,
      log: silent,
    });

    assert.equal(outcome.status, 'recorded');
    assert.ok(queries.some((q) => /INSERT INTO graph_embedding_model/i.test(q.sql)));
  });

  it('blocks an unrecorded corpus whose vectors have a different size', async () => {
    const { pool, queries } = makeFakePool([[], [{ dims: 768 }]]);

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OPENAI_SMALL,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    assert.equal(allowsVectorWrites(outcome), false);
    assert.ok(
      !queries.some((q) => /INSERT INTO graph_embedding_model/i.test(q.sql)),
      'a blocked provider must not claim the corpus',
    );
  });

  it('passes through when the recorded model equals the active one', async () => {
    const { pool, queries } = makeFakePool([
      [{ model_id: OLLAMA.modelId, dimensions: OLLAMA.dimensions }],
    ]);

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OLLAMA,
      log: silent,
    });

    assert.equal(outcome.status, 'match');
    assert.equal(allowsVectorWrites(outcome), true);
    assert.equal(queries.length, 1, 'a matching provider must not write anything');
  });

  it('blocks a provider whose dimensions differ from the recorded model', async () => {
    const { pool, queries } = makeFakePool([
      [{ model_id: OLLAMA.modelId, dimensions: OLLAMA.dimensions }],
    ]);

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OPENAI_SMALL,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    assert.equal(allowsVectorWrites(outcome), false);
    if (outcome.status === 'blocked') {
      assert.equal(outcome.reason, 'dimension-mismatch');
      assert.equal(outcome.storedModelId, OLLAMA.modelId);
      assert.equal(outcome.storedDimensions, 768);
      assert.equal(outcome.dimensions, 1536);
    }
    assert.ok(
      !queries.some((q) => /UPDATE graph_nodes/i.test(q.sql)),
      'a blocked provider must not touch stored vectors',
    );
  });

  it('clears stored vectors for re-embedding on a same-dimension model switch', async () => {
    const { pool, queries } = makeFakePool(
      [[{ model_id: OLLAMA.modelId, dimensions: OLLAMA.dimensions }]],
      42,
    );

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OTHER_768,
      log: silent,
    });

    assert.equal(outcome.status, 're-embedding');
    assert.equal(allowsVectorWrites(outcome), true);
    if (outcome.status === 're-embedding') {
      assert.equal(outcome.previousModelId, OLLAMA.modelId);
      assert.equal(outcome.clearedVectors, 42);
    }
    const clear = queries.find((q) => /UPDATE graph_nodes/i.test(q.sql));
    assert.ok(clear, 'expected stored vectors to be NULLed');
    assert.match(clear.sql, /embedding = NULL/);
    // The backfill only picks up rows below the attempt cap, so the counter
    // has to be reset along with the vector.
    assert.match(clear.sql, /embedding_attempts = 0/);
    assert.ok(queries.some((q) => /UPDATE graph_embedding_model/i.test(q.sql)));
    assert.ok(queries.some((q) => /^\s*COMMIT/i.test(q.sql)));
  });
});
