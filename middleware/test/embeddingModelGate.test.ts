import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  allowsVectorWrites,
  evaluateEmbeddingModelGate,
} from '@omadia/knowledge-graph-neon/dist/embeddingModelGate.js';

// ---------------------------------------------------------------------------
// FakePool — routes on the SQL rather than on call order, because the gate's
// query sequence now depends on which branch it takes (catalog probe → model
// record → optional corpus probe → insert/update/clear).
// ---------------------------------------------------------------------------

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

interface FakePoolScript {
  /** Rows the catalog probe returns (declared vector-column widths). */
  columns?: ReadonlyArray<{
    table_name: string;
    column_name: string;
    declared_type: string;
    typmod: number;
  }>;
  /** Row in `graph_embedding_model`, if any. */
  storedModel?: { model_id: string; dimensions: number };
  /** Whether the corpus already holds vectors. */
  hasVectors?: boolean;
  /** Rows each clear batch reports as affected. */
  clearedPerBatch?: number;
}

const DEFAULT_COLUMNS = [
  {
    table_name: 'graph_nodes',
    column_name: 'embedding',
    declared_type: 'vector(768)',
    typmod: 768,
  },
  {
    table_name: 'processes',
    column_name: 'embedding',
    declared_type: 'vector(768)',
    typmod: 768,
  },
];

function makeFakePool(script: FakePoolScript = {}): {
  pool: Pool;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const columns = script.columns ?? DEFAULT_COLUMNS;

  const driverQuery = (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): QueryResult => {
    queries.push({ sql, params: params ?? [] });
    const result = (rows: ReadonlyArray<Record<string, unknown>>, rowCount?: number): QueryResult =>
      ({
        command: '',
        rowCount: rowCount ?? rows.length,
        oid: 0,
        rows: [...rows],
        fields: [],
      }) as unknown as QueryResult;

    if (/FROM pg_attribute/i.test(sql)) return result(columns);
    if (/SELECT model_id, dimensions\s+FROM graph_embedding_model/i.test(sql)) {
      return result(script.storedModel ? [script.storedModel] : []);
    }
    if (/SELECT clear_pending/i.test(sql)) return result([]);
    if (/SELECT 1\s+FROM graph_nodes/i.test(sql)) {
      return result(script.hasVectors === true ? [{ '?column?': 1 }] : []);
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

const OLLAMA = { modelId: 'ollama:nomic-embed-text', dimensions: 768 };
const OPENAI_SMALL = { modelId: 'openai:text-embedding-3-small', dimensions: 1536 };
const OTHER_768 = { modelId: 'openai:some-768-model', dimensions: 768 };

const silent = (): void => undefined;

describe('evaluateEmbeddingModelGate', () => {
  it('allows writes and records nothing when the provider has no metadata', async () => {
    const { pool, queries } = makeFakePool();

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

  it('blocks a provider wider than the declared column on an EMPTY corpus', async () => {
    // The headline case: fresh deployment, no rows anywhere, operator installs
    // a 1536-dim provider against vector(768) columns. Sampling stored rows
    // sees nothing here — only the catalog knows.
    const { pool, queries } = makeFakePool({ hasVectors: false });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OPENAI_SMALL,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    assert.equal(allowsVectorWrites(outcome), false);
    if (outcome.status === 'blocked' && outcome.reason === 'column-width-mismatch') {
      assert.deepEqual(
        outcome.mismatches.map((m) => `${m.table}.${m.column}`),
        ['graph_nodes.embedding', 'processes.embedding'],
      );
    } else {
      assert.fail(`expected a column-width-mismatch block, got ${JSON.stringify(outcome)}`);
    }
    assert.ok(
      !queries.some((q) => /INSERT INTO graph_embedding_model/i.test(q.sql)),
      'a provider the columns cannot hold must not claim the corpus',
    );
  });

  it('blocks when only the SECOND governed column disagrees', async () => {
    // processes.embedding is a separate cosine space; a partial migration
    // that resized graph_nodes only must not read as healthy.
    const { pool } = makeFakePool({
      columns: [
        {
          table_name: 'graph_nodes',
          column_name: 'embedding',
          declared_type: 'vector(1536)',
          typmod: 1536,
        },
        {
          table_name: 'processes',
          column_name: 'embedding',
          declared_type: 'vector(768)',
          typmod: 768,
        },
      ],
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OPENAI_SMALL,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked' && outcome.reason === 'column-width-mismatch') {
      assert.deepEqual(
        outcome.mismatches.map((m) => m.table),
        ['processes'],
      );
    } else {
      assert.fail('expected the processes column to trip the gate');
    }
  });

  it('records the active model on a first run with an empty corpus', async () => {
    const { pool, queries } = makeFakePool({ hasVectors: false });

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

  it('adopts an unrecorded pre-#440 corpus when the columns already match', async () => {
    const { pool, queries } = makeFakePool({ hasVectors: true });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OLLAMA,
      log: silent,
    });

    assert.equal(outcome.status, 'recorded');
    assert.ok(queries.some((q) => /INSERT INTO graph_embedding_model/i.test(q.sql)));
  });

  it('passes through when the recorded model equals the active one', async () => {
    const { pool, queries } = makeFakePool({ storedModel: { model_id: OLLAMA.modelId, dimensions: 768 } });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OLLAMA,
      log: silent,
    });

    assert.equal(outcome.status, 'match');
    assert.equal(allowsVectorWrites(outcome), true);
    assert.ok(
      !queries.some((q) => /^\s*(UPDATE|INSERT)/i.test(q.sql)),
      'a matching provider must not write anything',
    );
  });

  it('blocks a provider whose dimensions differ from the recorded model', async () => {
    // Columns already migrated to 1536, but the corpus was embedded at 768.
    const { pool, queries } = makeFakePool({
      columns: [
        {
          table_name: 'graph_nodes',
          column_name: 'embedding',
          declared_type: 'vector(1536)',
          typmod: 1536,
        },
      ],
      storedModel: { model_id: OLLAMA.modelId, dimensions: 768 },
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OPENAI_SMALL,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    assert.equal(allowsVectorWrites(outcome), false);
    if (outcome.status === 'blocked' && outcome.reason === 'dimension-mismatch') {
      assert.equal(outcome.storedModelId, OLLAMA.modelId);
      assert.equal(outcome.storedDimensions, 768);
      assert.equal(outcome.dimensions, 1536);
    } else {
      assert.fail('expected a dimension-mismatch block');
    }
    assert.ok(
      !queries.some((q) => /UPDATE graph_nodes/i.test(q.sql)),
      'a blocked provider must not touch stored vectors',
    );
  });

  it('clears BOTH governed vector columns on a same-dimension model switch', async () => {
    const { pool, queries } = makeFakePool({
      storedModel: { model_id: OLLAMA.modelId, dimensions: 768 },
      clearedPerBatch: 42,
    });

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
      // one short batch per governed column
      assert.equal(outcome.clearedVectors, 84);
      assert.equal(outcome.clearPending, false);
    }

    const graphClear = queries.find((q) => /^\s*UPDATE graph_nodes/i.test(q.sql));
    assert.ok(graphClear, 'expected graph_nodes vectors to be NULLed');
    assert.match(graphClear.sql, /embedding = NULL/);
    // The backfill only picks up rows below the attempt cap, so the counter
    // has to be reset along with the vector.
    assert.match(graphClear.sql, /embedding_attempts = 0/);
    // Bounded: no unbounded tenant-wide UPDATE during activation.
    assert.match(graphClear.sql, /ctid IN \(/);
    assert.ok(
      queries.some((q) => /SET LOCAL statement_timeout/i.test(q.sql)),
      'each clear batch must carry a statement timeout',
    );

    const processClear = queries.find((q) => /^\s*UPDATE processes/i.test(q.sql));
    assert.ok(processClear, 'processes.embedding is a governed cosine space too');
    assert.match(processClear.sql, /embedding = NULL/);

    const registryWrite = queries.find((q) =>
      /UPDATE graph_embedding_model[\s\S]*clear_pending = TRUE/i.test(q.sql),
    );
    assert.ok(registryWrite, 'the switch must be durable before any row is touched');
    assert.ok(
      queries.indexOf(registryWrite) < queries.indexOf(graphClear),
      'clear_pending has to be set BEFORE clearing so the work is resumable',
    );
    assert.ok(
      queries.some((q) => /clear_pending = FALSE/i.test(q.sql)),
      'a completed clear must lower the flag again',
    );
  });

  it('leaves clear_pending raised when the activation cap is hit', async () => {
    const { pool, queries } = makeFakePool({
      storedModel: { model_id: OLLAMA.modelId, dimensions: 768 },
      // Every batch reports a full batch → the loop only stops at the cap.
      clearedPerBatch: 10,
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OTHER_768,
      clearBatchSize: 10,
      clearMaxRowsPerActivation: 20,
      log: silent,
    });

    assert.equal(outcome.status, 're-embedding');
    if (outcome.status === 're-embedding') {
      assert.equal(outcome.clearPending, true, 'the backfill sweep owes the rest');
      assert.equal(outcome.clearedVectors, 40); // cap per column, two columns
    }
    assert.ok(
      !queries.some((q) => /clear_pending = FALSE/i.test(q.sql)),
      'an unfinished clear must not report itself as done',
    );
  });
});
