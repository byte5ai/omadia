import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import {
  allowsVectorWrites,
  evaluateEmbeddingModelGate,
} from '@omadia/knowledge-graph-neon/dist/embeddingModelGate.js';

/**
 * #440 — the runtime vector-column width migration, against a REAL Postgres.
 *
 * Nothing here can be faked usefully. `ALTER TABLE … DROP COLUMN`, HNSW index
 * recreation from `pg_get_indexdef`, DDL inside a transaction, and
 * `lock_timeout` against a concurrent AccessShareLock are the entire subject.
 *
 * Lives beside `embeddingModelGate.pg.test.ts` rather than inside it: that file
 * is already 600+ lines, and these tests need their own schema anyway — they
 * MUTATE the column widths, so sharing the sibling's tables would leak state
 * into every test that assumes vector(768).
 *
 * Self-skips when no Postgres is reachable, same convention as its sibling.
 */

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const SCHEMA = 'embgate_migrate_test';

let pgAvailable = true;
try {
  const probe = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 1_500 });
  await probe.query('SELECT 1');
  await probe.query('CREATE EXTENSION IF NOT EXISTS vector');
  await probe.end();
} catch {
  pgAvailable = false;
}

const OLLAMA_768 = { modelId: 'ollama:nomic-embed-text', dimensions: 768 };
const OPENAI_1536 = { modelId: 'openai:text-embedding-3-small', dimensions: 1536 };

const silent = (): void => undefined;
const VEC768 = `[${new Array(768).fill(0.01).join(',')}]`;

describe('#440 runtime vector-column migration (real Postgres)', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    pool = new Pool({
      connectionString: PG_URL,
      max: 8,
      options: `-c search_path=${SCHEMA}`,
    });
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
  });

  after(async () => {
    await pool.end();
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  /**
   * Fresh tables per test. The whole point of this suite is that it changes
   * column widths, so nothing may be shared between cases.
   */
  async function freshSchema(opts: {
    nodesWithVectors?: number;
    exhaustedNodes?: number;
    processesWithVectors?: number;
    registry?: { modelId: string; dimensions: number; clearPending?: boolean; ageDays?: number };
  }): Promise<void> {
    await pool.query('DROP TABLE IF EXISTS graph_nodes, processes, graph_embedding_model');
    await pool.query(`
      CREATE TABLE graph_nodes (
        id                      TEXT PRIMARY KEY,
        tenant_id               TEXT NOT NULL,
        embedding               public.vector(768),
        embedding_attempts      INTEGER NOT NULL DEFAULT 0,
        embedding_last_error    TEXT,
        embedding_last_error_at TIMESTAMPTZ
      )`);
    // The real schema's index shape: an HNSW cosine index with explicit build
    // parameters. Both are things hand-built recreation SQL loses.
    await pool.query(`
      CREATE INDEX idx_graph_nodes_embedding
        ON graph_nodes USING hnsw (embedding public.vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)`);
    await pool.query(`CREATE INDEX idx_graph_nodes_tenant ON graph_nodes (tenant_id)`);
    await pool.query(`
      CREATE TABLE processes (
        id         TEXT NOT NULL,
        tenant_id  TEXT NOT NULL,
        embedding  public.vector(768),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id)
      )`);
    await pool.query(`
      CREATE INDEX idx_processes_embedding
        ON processes USING hnsw (embedding public.vector_cosine_ops)`);
    await pool.query(`
      CREATE TABLE graph_embedding_model (
        tenant_id     TEXT PRIMARY KEY,
        model_id      TEXT        NOT NULL,
        dimensions    INTEGER     NOT NULL,
        clear_pending BOOLEAN     NOT NULL DEFAULT FALSE,
        recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    for (let i = 0; i < (opts.nodesWithVectors ?? 0); i++) {
      await pool.query(
        'INSERT INTO graph_nodes (id, tenant_id, embedding) VALUES ($1, $2, $3::public.vector)',
        [`node:${String(i)}`, 'default', VEC768],
      );
    }
    for (let i = 0; i < (opts.exhaustedNodes ?? 0); i++) {
      await pool.query(
        `INSERT INTO graph_nodes (id, tenant_id, embedding, embedding_attempts, embedding_last_error)
         VALUES ($1, $2, NULL, 5, 'old provider was down')`,
        [`exhausted:${String(i)}`, 'default'],
      );
    }
    for (let i = 0; i < (opts.processesWithVectors ?? 0); i++) {
      await pool.query(
        'INSERT INTO processes (id, tenant_id, embedding) VALUES ($1, $2, $3::public.vector)',
        [`proc:${String(i)}`, 'default', VEC768],
      );
    }
    if (opts.registry) {
      await pool.query(
        `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions, clear_pending, updated_at)
         VALUES ('default', $1, $2, $3, now() - ($4 || ' days')::interval)`,
        [
          opts.registry.modelId,
          opts.registry.dimensions,
          opts.registry.clearPending ?? false,
          String(opts.registry.ageDays ?? 1),
        ],
      );
    }
  }

  const declaredType = async (table: string): Promise<string | undefined> => {
    const r = await pool.query<{ t: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND a.attname = 'embedding'
          AND NOT a.attisdropped AND n.nspname = $2`,
      [table, SCHEMA],
    );
    return r.rows[0]?.t;
  };

  const indexDefs = async (table: string): Promise<string[]> => {
    const r = await pool.query<{ d: string }>(
      `SELECT indexdef AS d FROM pg_indexes
        WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [SCHEMA, table],
    );
    return r.rows.map((x) => x.d);
  };

  const countVectors = async (table: string): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE embedding IS NOT NULL`,
    );
    return Number(r.rows[0]?.n ?? 0);
  };

  const registryRow = async (): Promise<
    { model_id: string; dimensions: number; clear_pending: boolean } | undefined
  > => {
    const r = await pool.query<{
      model_id: string;
      dimensions: number;
      clear_pending: boolean;
    }>('SELECT model_id, dimensions, clear_pending FROM graph_embedding_model');
    return r.rows[0];
  };

  it('rewrites every governed column at the provider width and re-embeds from NULL', async () => {
    await freshSchema({
      nodesWithVectors: 3,
      exhaustedNodes: 2,
      processesWithVectors: 2,
      registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
    });
    const nodeIndexesBefore = await indexDefs('graph_nodes');
    const processIndexesBefore = await indexDefs('processes');

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 'default',
      provider: OPENAI_1536,
      log: silent,
    });

    assert.equal(outcome.status, 'column-migrated');
    assert.equal(
      allowsVectorWrites(outcome),
      true,
      'the columns fit now and nothing old is left — writes must be ON immediately',
    );
    if (outcome.status === 'column-migrated') {
      assert.equal(outcome.dimensions, 1536);
      assert.equal(outcome.previousModelId, OLLAMA_768.modelId);
      assert.equal(outcome.previousDimensions, 768);
      assert.equal(outcome.discardedVectors, 5, '3 nodes + 2 processes');
      assert.deepEqual(
        outcome.migratedColumns.map((m) => `${m.table}.${m.column}`).sort(),
        ['graph_nodes.embedding', 'processes.embedding'],
      );
    }

    assert.equal(await declaredType('graph_nodes'), 'public.vector(1536)');
    assert.equal(await declaredType('processes'), 'public.vector(1536)');

    // The HNSW opclass does not encode the dimension, so a correctly replayed
    // definition is byte-identical — including WITH (m, ef_construction) and
    // the unrelated tenant index, which must survive untouched.
    assert.deepEqual(await indexDefs('graph_nodes'), nodeIndexesBefore);
    assert.deepEqual(await indexDefs('processes'), processIndexesBefore);

    assert.equal(await countVectors('graph_nodes'), 0, 'every vector is gone');
    assert.equal(await countVectors('processes'), 0);

    const stuck = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM graph_nodes WHERE embedding_attempts <> 0',
    );
    assert.equal(
      Number(stuck.rows[0]?.n),
      0,
      'the rows the OLD provider exhausted must be re-eligible for the backfill',
    );

    const reg = await registryRow();
    assert.equal(reg?.model_id, OPENAI_1536.modelId);
    assert.equal(reg?.dimensions, 1536);
    assert.equal(
      reg?.clear_pending,
      false,
      'the columns are empty by construction — there is nothing left to clear',
    );
  });

  it('adopts an unrecorded corpus by INSERTing the registry row after the swap', async () => {
    await freshSchema({ nodesWithVectors: 1 });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 'default',
      provider: OPENAI_1536,
      log: silent,
    });

    assert.equal(outcome.status, 'column-migrated');
    if (outcome.status === 'column-migrated') {
      assert.equal(outcome.previousModelId, undefined);
    }
    const reg = await registryRow();
    assert.equal(reg?.model_id, OPENAI_1536.modelId);
    assert.equal(reg?.dimensions, 1536);
  });

  it('subsumes a pending stale-vector clear rather than leaving the flag up', async () => {
    // A width migration destroys strictly more than the clear ever would, so
    // an owed clear that survived the swap would refuse writes forever over
    // rows that no longer exist.
    await freshSchema({
      nodesWithVectors: 2,
      registry: {
        modelId: OLLAMA_768.modelId,
        dimensions: 768,
        clearPending: true,
        ageDays: 3,
      },
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 'default',
      provider: OPENAI_1536,
      log: silent,
    });

    assert.equal(outcome.status, 'column-migrated');
    assert.equal(allowsVectorWrites(outcome), true);
    assert.equal((await registryRow())?.clear_pending, false);
  });

  it('does nothing at all when the flag is off — the old blocked outcome, intact', async () => {
    await freshSchema({
      nodesWithVectors: 3,
      registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
    });
    const before = await indexDefs('graph_nodes');

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 'default',
      provider: OPENAI_1536,
      autoMigrateVectorColumns: false,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'column-width-mismatch');
    assert.equal(allowsVectorWrites(outcome), false);
    assert.equal(await declaredType('graph_nodes'), 'public.vector(768)');
    assert.equal(await countVectors('graph_nodes'), 3, 'not one vector may be dropped');
    assert.deepEqual(await indexDefs('graph_nodes'), before);
    const reg = await registryRow();
    assert.equal(reg?.model_id, OLLAMA_768.modelId, 'the registry stays untouched');
    assert.equal(reg?.dimensions, 768);
  });

  it('the anti-oscillation cooldown blocks the migration exactly as it blocks a switch', async () => {
    // A rolling deploy with two providers would otherwise take turns dropping
    // each other's columns — the same failure the cooldown was written for,
    // one order of magnitude more expensive.
    await freshSchema({
      nodesWithVectors: 4,
      registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 0 },
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 'default',
      provider: OPENAI_1536,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'column-width-mismatch');
    assert.equal(await declaredType('graph_nodes'), 'public.vector(768)');
    assert.equal(await countVectors('graph_nodes'), 4);
    assert.equal((await registryRow())?.dimensions, 768);
  });

  it('a failing DDL leaves the column fully old and the registry untouched', async () => {
    await freshSchema({
      nodesWithVectors: 3,
      processesWithVectors: 2,
      registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
    });
    const nodeIndexesBefore = await indexDefs('graph_nodes');

    // A real reader holding AccessShareLock on graph_nodes. `DROP COLUMN`
    // wants AccessExclusiveLock, cannot get it, and the migration's
    // `lock_timeout` fires — the honest version of "the DDL failed".
    const blocker = new Pool({
      connectionString: PG_URL,
      max: 1,
      options: `-c search_path=${SCHEMA}`,
    });
    const held = await blocker.connect();
    await held.query('BEGIN');
    await held.query('SELECT count(*) FROM graph_nodes');

    try {
      const outcome = await evaluateEmbeddingModelGate({
        pool,
        tenantId: 'default',
        provider: OPENAI_1536,
        log: silent,
      });

      assert.equal(outcome.status, 'blocked');
      if (outcome.status === 'blocked') {
        assert.equal(outcome.reason, 'column-width-mismatch');
      }
      assert.equal(
        await declaredType('graph_nodes'),
        'public.vector(768)',
        'fully old — never half-migrated',
      );
      assert.equal(await countVectors('graph_nodes'), 3);
      assert.deepEqual(
        await indexDefs('graph_nodes'),
        nodeIndexesBefore,
        'the dropped indexes were rolled back with everything else',
      );
      assert.equal(
        await declaredType('processes'),
        'public.vector(768)',
        'graph_nodes is migrated first, so processes was never reached',
      );
      const reg = await registryRow();
      assert.equal(reg?.model_id, OLLAMA_768.modelId);
      assert.equal(reg?.dimensions, 768);
      assert.equal(reg?.clear_pending, false);
    } finally {
      await held.query('ROLLBACK');
      held.release();
      await blocker.end();
    }
  });

  it('a second activation resumes cleanly once the blocker is gone', async () => {
    // Same tables the previous case left fully un-migrated: the operator does
    // nothing, the next boot just works.
    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 'default',
      provider: OPENAI_1536,
      log: silent,
    });
    assert.equal(outcome.status, 'column-migrated');
    assert.equal(await declaredType('graph_nodes'), 'public.vector(1536)');
    assert.equal(await declaredType('processes'), 'public.vector(1536)');
    assert.equal((await registryRow())?.dimensions, 1536);
  });

  it('an already-correct column is a no-op, so a partial run finishes on the next boot', async () => {
    await freshSchema({
      registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
    });
    // Simulate a run that got through graph_nodes and died before processes.
    await pool.query('DROP INDEX idx_graph_nodes_embedding');
    await pool.query('ALTER TABLE graph_nodes DROP COLUMN embedding');
    await pool.query('ALTER TABLE graph_nodes ADD COLUMN embedding public.vector(1536)');
    await pool.query(
      `CREATE INDEX idx_graph_nodes_embedding ON graph_nodes
         USING hnsw (embedding public.vector_cosine_ops) WITH (m = 16, ef_construction = 64)`,
    );

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: 'default',
      provider: OPENAI_1536,
      log: silent,
    });

    assert.equal(outcome.status, 'column-migrated');
    if (outcome.status === 'column-migrated') {
      assert.deepEqual(
        outcome.migratedColumns.map((m) => m.table),
        ['processes'],
        'graph_nodes was already at 1536 and must not be rewritten again',
      );
    }
    assert.equal(await declaredType('processes'), 'public.vector(1536)');
    assert.equal((await registryRow())?.dimensions, 1536);
  });
});
