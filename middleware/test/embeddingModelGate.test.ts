import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  allowsVectorWrites,
  evaluateEmbeddingModelGate,
  requiresStaleVectorClearResume,
} from '@omadia/knowledge-graph-neon/dist/embeddingModelGate.js';

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
  storedModel?: {
    model_id: string;
    dimensions: number;
    clear_pending?: boolean;
    /** How long ago the registry row was written. Defaults to "long ago" so
     *  the switch cooldown does not fire in tests that are not about it. */
    ageMs?: number;
  };
  /** Whether the corpus already holds vectors. */
  hasVectors?: boolean;
  /** Non-NULL vectors per governed column, drained batch by batch. */
  vectorRows?: Record<string, number>;
  /** Rows matching the exhausted-`embedding_attempts` reset predicate. */
  attemptRows?: number;
  /** Simulate another clearer already holding the advisory lock. */
  clearLockHeld?: boolean;
  /** Simulate losing the INSERT race: RETURNING yields nothing and the
   *  re-SELECT sees somebody else's row. */
  insertRaceWinner?: { model_id: string; dimensions: number };
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

/**
 * FakePool — routes on the SQL rather than on call order, because the gate's
 * query sequence depends on which branch it takes (catalog probe → registry
 * read → insert/CAS → clear batches → residual probes).
 *
 * It models remaining row COUNTS, not a constant per-batch number: the clear
 * now loops until a batch changes nothing and then re-probes for residual
 * rows, so a fake that reported the same rowCount forever would never let the
 * loop terminate the way the real one does.
 *
 * It is still a fake. Everything that depends on real Postgres semantics
 * (`FOR UPDATE SKIP LOCKED`, `ON CONFLICT` under concurrency, advisory locks,
 * `format_type`) is covered by embeddingModelGate.pg.test.ts.
 */
function makeFakePool(script: FakePoolScript = {}): {
  pool: Pool;
  queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  const columns = script.columns ?? DEFAULT_COLUMNS;
  const vectors: Record<string, number> = { ...(script.vectorRows ?? {}) };
  let attempts = script.attemptRows ?? 0;
  let insertRaceConsumed = false;

  const take = (key: string, limit: number): number => {
    const left = vectors[key] ?? 0;
    const n = Math.min(left, limit);
    vectors[key] = left - n;
    return n;
  };

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
      return m?.[1] !== undefined ? Number(m[1]) : 0;
    };

    if (/pg_try_advisory_lock/i.test(sql)) {
      return result([{ locked: script.clearLockHeld !== true }]);
    }
    if (/pg_advisory_xact_lock|pg_advisory_unlock/i.test(sql)) return result([]);
    if (/FROM pg_attribute/i.test(sql)) return result(columns);
    if (/INSERT INTO graph_embedding_model/i.test(sql)) {
      if (script.insertRaceWinner) {
        insertRaceConsumed = true;
        return result([], 0);
      }
      return result([
        {
          model_id: String(params?.[1] ?? ''),
          dimensions: Number(params?.[2] ?? 0),
          clear_pending: false,
          age_ms: 0,
        },
      ]);
    }
    if (/^\s*UPDATE graph_embedding_model/i.test(sql)) {
      // The CAS flip and the flag lowering both land here; a real row exists
      // in every test that reaches them.
      return result([], 1);
    }
    if (/FROM graph_embedding_model/i.test(sql)) {
      if (script.insertRaceWinner && insertRaceConsumed) {
        return result([
          { ...script.insertRaceWinner, clear_pending: false, age_ms: 0 },
        ]);
      }
      return result(
        script.storedModel
          ? [
              {
                model_id: script.storedModel.model_id,
                dimensions: script.storedModel.dimensions,
                clear_pending: script.storedModel.clear_pending === true,
                age_ms: script.storedModel.ageMs ?? 86_400_000,
              },
            ]
          : [],
      );
    }
    // Residual probes come first — they are SELECTs over the clear predicates.
    if (/SELECT 1 AS residual/i.test(sql)) {
      const table = /FROM (\w+)/.exec(sql)?.[1] ?? '';
      const left = /embedding_attempts > 0/.test(sql)
        ? attempts
        : (vectors[table] ?? 0);
      return result(left > 0 ? [{ residual: 1 }] : []);
    }
    if (/SELECT 1\s+FROM graph_nodes/i.test(sql)) {
      return result(script.hasVectors === true ? [{ '?column?': 1 }] : []);
    }
    if (/^\s*UPDATE (graph_nodes|processes)/i.test(sql)) {
      if (/embedding IS NULL AND embedding_attempts > 0/.test(sql)) {
        const n = Math.min(attempts, limitOf());
        attempts -= n;
        return result([], n);
      }
      const table = /^\s*UPDATE (\w+)/.exec(sql)?.[1] ?? '';
      return result([], take(table, limitOf()));
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
    assert.match(
      insert.sql,
      /RETURNING/,
      'ON CONFLICT DO NOTHING is a no-op on a lost race — the insert has to report whether it actually won',
    );
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

  it('BLOCKS instead of claiming the corpus when it loses the INSERT race', async () => {
    // Rolling deploy, fresh tenant: two instances with different adapters both
    // see no row. One insert wins, the other is a silent no-op — and used to
    // return {status:'recorded', modelId: <its own>} and start writing into a
    // vector space the registry says belongs to the winner.
    const { pool } = makeFakePool({
      insertRaceWinner: { model_id: OLLAMA.modelId, dimensions: 768 },
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OTHER_768,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    assert.equal(allowsVectorWrites(outcome), false);
    if (outcome.status === 'blocked' && outcome.reason === 'registry-conflict') {
      assert.equal(outcome.storedModelId, OLLAMA.modelId);
      assert.equal(outcome.modelId, OTHER_768.modelId);
    } else {
      assert.fail(`expected a registry-conflict block, got ${JSON.stringify(outcome)}`);
    }
  });

  it('passes through when the recorded model equals the active one', async () => {
    const { pool, queries } = makeFakePool({
      storedModel: { model_id: OLLAMA.modelId, dimensions: 768 },
    });

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
      vectorRows: { graph_nodes: 42, processes: 42 },
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
    // Without SKIP LOCKED a concurrent updater makes rows silently drop out of
    // the predicate after the LIMIT, which the loop would read as "done".
    assert.match(graphClear.sql, /FOR UPDATE SKIP LOCKED/);
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
    // Compare-and-swap: the flip is conditional on the row still being exactly
    // what was read under the lock.
    assert.match(registryWrite.sql, /AND model_id = \$4/);
    assert.match(registryWrite.sql, /AND dimensions = \$5/);
    assert.ok(
      queries.some((q) => /pg_advisory_xact_lock/i.test(q.sql)),
      'read-decide-switch must be serialised per tenant',
    );
    assert.ok(
      queries.some((q) => /clear_pending = FALSE/i.test(q.sql)),
      'a completed clear must lower the flag again',
    );
  });

  it('resets exhausted retry counters on rows the clear cannot reach', async () => {
    // A node whose embedding is ALREADY NULL because it burned its retries
    // under the dead old provider can never match "embedding IS NOT NULL", so
    // the reset riding along with the vector clear never touches it — and the
    // backfill's "embedding_attempts < maxAttempts" predicate then skips it
    // forever. It needs its own statement.
    const { pool, queries } = makeFakePool({
      storedModel: { model_id: OLLAMA.modelId, dimensions: 768 },
      vectorRows: { graph_nodes: 1, processes: 0 },
      attemptRows: 7,
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OTHER_768,
      log: silent,
    });

    assert.equal(outcome.status, 're-embedding');
    const reset = queries.find((q) =>
      /^\s*UPDATE graph_nodes[\s\S]*embedding IS NULL AND embedding_attempts > 0/i.test(
        q.sql,
      ),
    );
    assert.ok(
      reset,
      'expected a dedicated statement over rows whose vector is already NULL',
    );
    assert.match(reset.sql, /embedding_attempts = 0/);
  });

  it('leaves clear_pending raised when the activation cap is hit AND refuses writes', async () => {
    const { pool, queries } = makeFakePool({
      storedModel: { model_id: OLLAMA.modelId, dimensions: 768 },
      // More rows than the cap can drain in one activation.
      vectorRows: { graph_nodes: 5_000, processes: 5_000 },
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
    // The resumed clear NULLs every non-NULL vector it finds with no model or
    // timestamp discriminator, so a vector written during this window would be
    // destroyed by it — and sustained ingest would keep the pass from ever
    // draining. Writes stay off until the clear completes.
    assert.equal(
      allowsVectorWrites(outcome),
      false,
      'writes must be refused while a clear is owed',
    );
    assert.ok(
      !queries.some((q) => /clear_pending = FALSE/i.test(q.sql)),
      'an unfinished clear must not report itself as done',
    );
  });

  it('never lowers the flag over work another clearer holds the lock for', async () => {
    const { pool, queries } = makeFakePool({
      storedModel: { model_id: OLLAMA.modelId, dimensions: 768 },
      vectorRows: { graph_nodes: 10, processes: 10 },
      clearLockHeld: true,
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OTHER_768,
      log: silent,
    });

    assert.equal(outcome.status, 're-embedding');
    if (outcome.status === 're-embedding') {
      assert.equal(outcome.clearedVectors, 0);
      assert.equal(
        outcome.clearPending,
        true,
        'a clearer that could not take the lock has finished nothing',
      );
    }
    assert.equal(allowsVectorWrites(outcome), false);
    assert.ok(
      !queries.some((q) => /clear_pending = FALSE/i.test(q.sql)),
      'never lower the flag over rows another clearer is working on',
    );
  });

  it('resumes an owed clear on the MATCH path, where the registry already names us', async () => {
    // switchModelAndClearVectors flips model_id BEFORE clearing, so the boot
    // after an interrupted switch MATCHES. The backfill is the only other
    // resumer and it is conditional (graph_embedding_backfill_enabled=false,
    // or the embeddings plugin deactivated), so the match path has to consult
    // clear_pending itself or two models share one cosine space forever.
    const { pool, queries } = makeFakePool({
      storedModel: {
        model_id: OLLAMA.modelId,
        dimensions: 768,
        clear_pending: true,
      },
      vectorRows: { graph_nodes: 3, processes: 2 },
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OLLAMA,
      log: silent,
    });

    assert.equal(outcome.status, 'match');
    if (outcome.status === 'match') {
      assert.equal(outcome.clearPending, false, 'the resume finished the work');
    }
    assert.ok(
      queries.some((q) => /^\s*UPDATE graph_nodes[\s\S]*embedding = NULL/i.test(q.sql)),
      'the match path must resume the clear, not ignore it',
    );
    assert.ok(queries.some((q) => /clear_pending = FALSE/i.test(q.sql)));
  });

  it('refuses writes on a MATCH whose owed clear could not be finished', async () => {
    const { pool } = makeFakePool({
      storedModel: {
        model_id: OLLAMA.modelId,
        dimensions: 768,
        clear_pending: true,
      },
      vectorRows: { graph_nodes: 5_000, processes: 5_000 },
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OLLAMA,
      clearBatchSize: 5,
      clearMaxRowsPerActivation: 10,
      log: silent,
    });

    assert.equal(outcome.status, 'match');
    assert.equal(allowsVectorWrites(outcome), false);
    assert.equal(requiresStaleVectorClearResume(outcome), true);
  });

  it('refuses a destructive switch that follows a very recent registry write', async () => {
    // Rolling deploy, both machine versions briefly up with different 768d
    // adapters: each one switches and clears, wiping what the other just
    // re-embedded, with no error anywhere. The cooldown makes the second
    // switch loud instead of destructive.
    const { pool, queries } = makeFakePool({
      storedModel: {
        model_id: OLLAMA.modelId,
        dimensions: 768,
        ageMs: 5_000,
      },
      hasVectors: true,
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OTHER_768,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    assert.equal(allowsVectorWrites(outcome), false);
    if (outcome.status === 'blocked') {
      assert.equal(outcome.reason, 'registry-conflict');
    }
    assert.ok(
      !queries.some((q) => /^\s*UPDATE (graph_nodes|processes)/i.test(q.sql)),
      'no vector may be touched by a refused switch',
    );
    assert.ok(
      !queries.some((q) => /^\s*UPDATE graph_embedding_model/i.test(q.sql)),
      'and the registry must not move either',
    );
  });

  it('allows a recent-write switch when the corpus has nothing to lose', async () => {
    const { pool } = makeFakePool({
      storedModel: {
        model_id: OLLAMA.modelId,
        dimensions: 768,
        ageMs: 5_000,
      },
      hasVectors: false,
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 't1',
      provider: OTHER_768,
      log: silent,
    });

    assert.equal(outcome.status, 're-embedding');
  });
});
