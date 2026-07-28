import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import {
  allowsVectorWrites,
  clearStaleVectors,
  discoverGovernedVectorColumns,
  evaluateEmbeddingModelGate,
} from '@omadia/knowledge-graph-neon/dist/embeddingModelGate.js';

/**
 * #440 — the model/dimension gate against a REAL Postgres.
 *
 * The sibling `embeddingModelGate.test.ts` drives a hand-rolled pool that
 * regex-matches SQL strings. That is fine for branch coverage and useless for
 * everything this gate actually depends on: `format_type` on a pgvector
 * column, `INSERT … ON CONFLICT DO NOTHING RETURNING` under a real unique
 * constraint, `pg_advisory_lock` semantics, and whether a capped clear really
 * leaves the corpus in the state the resume path expects.
 *
 * Self-skips when no Postgres is reachable, same convention as
 * test/devplatform/*.pg.test.ts — never fails the suite on a machine without
 * a database.
 */

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const SCHEMA = 'embgate_pg_test';

let pgAvailable = true;
try {
  const probe = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 1_500 });
  await probe.query('SELECT 1');
  // pgvector is not optional here — a vector(n) column IS the thing under test.
  await probe.query('CREATE EXTENSION IF NOT EXISTS vector');
  await probe.end();
} catch {
  pgAvailable = false;
}

const OLLAMA = { modelId: 'ollama:nomic-embed-text', dimensions: 768 };
const OTHER_768 = { modelId: 'openai:some-768-model', dimensions: 768 };
const OPENAI_1536 = { modelId: 'openai:text-embedding-3-small', dimensions: 1536 };

const silent = (): void => undefined;

/** A valid 768-dimensional literal; the values do not matter, the width does. */
const VEC768 = `[${new Array(768).fill(0.01).join(',')}]`;

describe('embeddingModelGate against real Postgres', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    // ONLY the throwaway schema is on the path, and it is set as a connection
    // parameter so every pooled connection carries it before its first query:
    // the gate discovers governed columns via `current_schemas(false)`, and a
    // shared test database tends to have leftover graph_nodes/processes tables
    // in `public` that would otherwise be pulled into the gate's business. The
    // `vector` type is therefore spelled `public.vector` in the DDL below.
    pool = new Pool({
      connectionString: PG_URL,
      max: 8,
      options: `-c search_path=${SCHEMA}`,
    });

    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();

    await pool.query(`
      CREATE TABLE graph_nodes (
        id                      TEXT PRIMARY KEY,
        tenant_id               TEXT NOT NULL,
        embedding               public.vector(768),
        embedding_attempts      INTEGER NOT NULL DEFAULT 0,
        embedding_last_error    TEXT,
        embedding_last_error_at TIMESTAMPTZ
      )`);
    await pool.query(`
      CREATE TABLE processes (
        id        TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        embedding public.vector(768),
        PRIMARY KEY (tenant_id, id)
      )`);
    // Mirrors migration 0030.
    await pool.query(`
      CREATE TABLE graph_embedding_model (
        tenant_id     TEXT PRIMARY KEY,
        model_id      TEXT        NOT NULL,
        dimensions    INTEGER     NOT NULL,
        clear_pending BOOLEAN     NOT NULL DEFAULT FALSE,
        recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    // A vector column the gate must NOT govern: no tenant_id, so it belongs to
    // somebody else who happens to share the database.
    await pool.query(`CREATE TABLE unrelated_vectors (id TEXT, embedding public.vector(1536))`);

    const schema = await pool.query<{ s: string }>('SELECT current_schema() AS s');
    assert.equal(schema.rows[0]?.s, SCHEMA, 'search_path must reach the test schema');
  });

  after(async () => {
    await pool.end();
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  async function seed(
    tenant: string,
    opts: {
      nodesWithVectors?: number;
      processesWithVectors?: number;
      exhaustedNodes?: number;
      registry?: { modelId: string; dimensions: number; clearPending?: boolean; ageDays?: number };
    },
  ): Promise<void> {
    await pool.query('DELETE FROM graph_nodes WHERE tenant_id = $1', [tenant]);
    await pool.query('DELETE FROM processes WHERE tenant_id = $1', [tenant]);
    await pool.query('DELETE FROM graph_embedding_model WHERE tenant_id = $1', [tenant]);

    for (let i = 0; i < (opts.nodesWithVectors ?? 0); i++) {
      await pool.query(
        'INSERT INTO graph_nodes (id, tenant_id, embedding) VALUES ($1, $2, $3::public.vector)',
        [`${tenant}:node:${String(i)}`, tenant, VEC768],
      );
    }
    for (let i = 0; i < (opts.exhaustedNodes ?? 0); i++) {
      // The rows the reset exists for: NULL vector, retry budget spent.
      await pool.query(
        `INSERT INTO graph_nodes (id, tenant_id, embedding, embedding_attempts, embedding_last_error)
         VALUES ($1, $2, NULL, 5, 'old provider was down')`,
        [`${tenant}:exhausted:${String(i)}`, tenant],
      );
    }
    for (let i = 0; i < (opts.processesWithVectors ?? 0); i++) {
      await pool.query(
        'INSERT INTO processes (id, tenant_id, embedding) VALUES ($1, $2, $3::public.vector)',
        [`${tenant}:proc:${String(i)}`, tenant, VEC768],
      );
    }
    if (opts.registry) {
      await pool.query(
        `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions, clear_pending, updated_at)
         VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval)`,
        [
          tenant,
          opts.registry.modelId,
          opts.registry.dimensions,
          opts.registry.clearPending ?? false,
          String(opts.registry.ageDays ?? 1),
        ],
      );
    }
  }

  const countVectors = async (table: string, tenant: string): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1 AND embedding IS NOT NULL`,
      [tenant],
    );
    return Number(r.rows[0]?.n ?? 0);
  };

  const registryRow = async (
    tenant: string,
  ): Promise<{ model_id: string; clear_pending: boolean } | undefined> => {
    const r = await pool.query<{ model_id: string; clear_pending: boolean }>(
      'SELECT model_id, clear_pending FROM graph_embedding_model WHERE tenant_id = $1',
      [tenant],
    );
    return r.rows[0];
  };

  // -------------------------------------------------------------------------

  it('reads declared vector widths from the real catalog, and only tenant-scoped ones', async () => {
    const columns = await discoverGovernedVectorColumns(pool);
    const governed = columns.map((c) => `${c.table}.${c.column}=${String(c.declaredDimensions)}`);
    assert.deepEqual(governed.sort(), [
      'graph_nodes.embedding=768',
      'processes.embedding=768',
    ]);
    assert.ok(
      !columns.some((c) => c.table === 'unrelated_vectors'),
      'a vector column on a table without tenant_id is none of the gate business',
    );
  });

  it('blocks a 1536d provider against real vector(768) columns, on an empty corpus', async () => {
    const tenant = 'pg-width';
    await seed(tenant, {});

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: tenant,
      provider: OPENAI_1536,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    assert.equal(allowsVectorWrites(outcome), false);
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'column-width-mismatch');
    assert.equal(await registryRow(tenant), undefined, 'a refused provider claims nothing');
  });

  it('ON CONFLICT DO NOTHING really returns no row to the loser', async () => {
    // The assumption the RETURNING check is built on, verified against the
    // actual unique constraint rather than a regex.
    const tenant = 'pg-conflict';
    await seed(tenant, {});
    await pool.query(
      'INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions) VALUES ($1, $2, $3)',
      [tenant, OLLAMA.modelId, 768],
    );

    const loser = await pool.query(
      `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO NOTHING
       RETURNING model_id`,
      [tenant, OTHER_768.modelId, 768],
    );
    assert.equal(loser.rows.length, 0, 'a lost race must be observable');
    assert.equal((await registryRow(tenant))?.model_id, OLLAMA.modelId);
  });

  it('two instances racing a fresh corpus: exactly one records, the other never claims it', async () => {
    // Rolling deploy against a pre-#440 corpus (vectors, no registry row). Both
    // instances see no row and try to adopt. The old code returned
    // {status:'recorded', modelId:<own>} to BOTH and let the loser write into a
    // vector space the registry says belongs to the winner.
    const tenant = 'pg-race';
    await seed(tenant, { nodesWithVectors: 4 });

    const [a, b] = await Promise.all([
      evaluateEmbeddingModelGate({
        pool,
        tenantId: tenant,
        provider: OLLAMA,
        log: silent,
      }),
      evaluateEmbeddingModelGate({
        pool,
        tenantId: tenant,
        provider: OTHER_768,
        log: silent,
      }),
    ]);

    const recorded = [a, b].filter((o) => o.status === 'recorded');
    assert.equal(recorded.length, 1, 'exactly one instance may claim a fresh corpus');
    const other = a.status === 'recorded' ? b : a;
    assert.equal(other.status, 'blocked', 'the loser must not report success');
    assert.equal(allowsVectorWrites(other), false);

    const stored = await registryRow(tenant);
    const winner = recorded[0];
    assert.ok(winner && winner.status === 'recorded');
    assert.equal(stored?.model_id, winner.modelId, 'the registry names the winner');
    assert.equal(
      await countVectors('graph_nodes', tenant),
      4,
      'a contested boot must not clear anything',
    );
  });

  it('switch → partial clear → resume, end to end', async () => {
    const tenant = 'pg-switch';
    await seed(tenant, {
      nodesWithVectors: 60,
      processesWithVectors: 20,
      exhaustedNodes: 3,
      registry: { modelId: OLLAMA.modelId, dimensions: 768, ageDays: 2 },
    });

    // --- activation: capped, so it cannot stall boot on a large corpus ------
    const first = await evaluateEmbeddingModelGate({
      pool,
      tenantId: tenant,
      provider: OTHER_768,
      clearBatchSize: 10,
      clearMaxRowsPerActivation: 20,
      log: silent,
    });

    assert.equal(first.status, 're-embedding');
    if (first.status === 're-embedding') {
      assert.equal(first.previousModelId, OLLAMA.modelId);
      assert.equal(first.clearPending, true);
      assert.equal(first.clearedVectors, 40, '20 per governed column');
    }
    // Writes stay refused: the resumed clear NULLs every non-NULL vector it
    // finds, with no discriminator, so anything written now would be destroyed
    // by it — and sustained ingest would keep it from ever draining.
    assert.equal(allowsVectorWrites(first), false);

    assert.equal(await countVectors('graph_nodes', tenant), 40);
    assert.equal(await countVectors('processes', tenant), 0);
    const mid = await registryRow(tenant);
    assert.equal(mid?.model_id, OTHER_768.modelId, 'the flip is durable before the clear');
    assert.equal(mid?.clear_pending, true);

    // Rows that were already NULL with a spent retry budget get a fresh one —
    // otherwise the backfill's `embedding_attempts < maxAttempts` predicate
    // skips them forever and the switch never rescues them.
    const stuck = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM graph_nodes
        WHERE tenant_id = $1 AND embedding IS NULL AND embedding_attempts > 0`,
      [tenant],
    );
    assert.equal(Number(stuck.rows[0]?.n), 0, 'exhausted retry counters must be reset');

    // --- another instance cannot clear concurrently ------------------------
    const holder = new Pool({ connectionString: PG_URL, max: 1 });
    try {
      await holder.query('SELECT pg_advisory_lock(4401, hashtext($1)::int)', [tenant]);
      const blocked = await clearStaleVectors(pool, tenant, {
        batchSize: 100,
        maxRows: 10_000,
        statementTimeoutMs: 15_000,
      });
      assert.equal(blocked.totalCleared, 0);
      assert.equal(blocked.pending, true, 'never report somebody else work as done');
      assert.equal(
        (await registryRow(tenant))?.clear_pending,
        true,
        'and never lower the flag over it',
      );
      assert.equal(await countVectors('graph_nodes', tenant), 40, 'nothing was touched');
    } finally {
      await holder.query('SELECT pg_advisory_unlock(4401, hashtext($1)::int)', [tenant]);
      await holder.end();
    }

    // --- next boot: the registry already names US, so this is the MATCH path,
    //     which has to notice clear_pending and finish the job ---------------
    const second = await evaluateEmbeddingModelGate({
      pool,
      tenantId: tenant,
      provider: OTHER_768,
      clearBatchSize: 25,
      clearMaxRowsPerActivation: 10_000,
      log: silent,
    });

    assert.equal(second.status, 'match');
    if (second.status === 'match') assert.equal(second.clearPending, false);
    assert.equal(allowsVectorWrites(second), true, 'writes resume once the clear is done');
    assert.equal(await countVectors('graph_nodes', tenant), 0);
    assert.equal(await countVectors('processes', tenant), 0);
    const end = await registryRow(tenant);
    assert.equal(end?.clear_pending, false);
    assert.equal(end?.model_id, OTHER_768.modelId);
  });

  it('a still-owed clear keeps writes refused on the match path too', async () => {
    const tenant = 'pg-owed';
    await seed(tenant, {
      nodesWithVectors: 30,
      registry: { modelId: OLLAMA.modelId, dimensions: 768, clearPending: true, ageDays: 3 },
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: tenant,
      provider: OLLAMA,
      clearBatchSize: 5,
      clearMaxRowsPerActivation: 10,
      log: silent,
    });

    assert.equal(outcome.status, 'match');
    assert.equal(allowsVectorWrites(outcome), false);
    assert.equal(await countVectors('graph_nodes', tenant), 20, 'capped at 10 this pass');
    assert.equal((await registryRow(tenant))?.clear_pending, true);
  });

  it('refuses a switch whose registry row was written moments ago on a live corpus', async () => {
    const tenant = 'pg-cooldown';
    await seed(tenant, {
      nodesWithVectors: 5,
      registry: { modelId: OLLAMA.modelId, dimensions: 768, ageDays: 0 },
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: tenant,
      provider: OTHER_768,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'registry-conflict');
    assert.equal(await countVectors('graph_nodes', tenant), 5, 'no vector may be destroyed');
    assert.equal((await registryRow(tenant))?.model_id, OLLAMA.modelId);
  });

  it('blocks on a real recorded-dimension mismatch without touching vectors', async () => {
    const tenant = 'pg-dims';
    await seed(tenant, {
      nodesWithVectors: 3,
      registry: { modelId: OLLAMA.modelId, dimensions: 1536, ageDays: 2 },
    });

    const outcome = await evaluateEmbeddingModelGate({
      pool,
      tenantId: tenant,
      // Matches the columns (768) but not the recorded corpus (1536).
      provider: OTHER_768,
      log: silent,
    });

    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.reason, 'dimension-mismatch');
    assert.equal(await countVectors('graph_nodes', tenant), 3);
  });
});
