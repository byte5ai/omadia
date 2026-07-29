import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { Pool } from 'pg';

import {
  allowsVectorWrites,
  evaluateEmbeddingModelGate,
} from '@omadia/knowledge-graph-neon/dist/embeddingModelGate.js';
import { clearStaleVectors } from '@omadia/knowledge-graph-neon/dist/staleVectorClear.js';
import { captureIndexDefs } from '@omadia/knowledge-graph-neon/dist/vectorColumnCatalog.js';
import { migrateVectorColumns } from '@omadia/knowledge-graph-neon/dist/vectorColumnMigration.js';

/**
 * #440 follow-up — the GUARDS around the runtime vector-column width
 * migration, against a REAL Postgres.
 *
 * Sibling of `embeddingModelGateMigration.pg.test.ts`, which owns the happy
 * path and was already at ~460 lines. These cases are about the four ways the
 * migration was wrong rather than about the swap itself, and every one of them
 * needs its own table shape:
 *
 *   F1 — index capture missed predicate/expression indexes, and `DROP COLUMN`
 *        destroyed them silently. The shipped `0006`/`0022` backfill scan
 *        indexes are exactly that shape.
 *   F2 — the attempt-reset UPDATE was unbounded inside the DDL transaction, so
 *        a large tenant livelocked on `statement_timeout` → rollback → blocked,
 *        forever.
 *   F3 — the session advisory lock leaked on every throw except one, and a
 *        leaked lock in this namespace HANGS `decideRegistry` rather than
 *        degrading it.
 *   F4 — the cooldown probed the columns the previous migration had just
 *        re-created empty, so it could not survive the operation it guards.
 *
 * Self-skips when no Postgres is reachable, same convention as its siblings.
 */

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const SCHEMA = 'embgate_migrate_guards_test';
/**
 * A tenant of this suite's OWN, not 'default'.
 *
 * The registry advisory lock is keyed on `hashtext(tenantId)` in a fixed
 * namespace and is therefore DATABASE-wide, not schema-scoped: sharing
 * 'default' with `embeddingModelGateMigration.pg.test.ts` made the two files
 * contend for real when the runner executes them in parallel, and the loser
 * came back `lock-held` — a genuine cross-file collision, not flake.
 */
const TENANT = 'guards-440';

let pgAvailable = true;
const probe = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 1_500 });
try {
  await probe.query('SELECT 1');
  await probe.query('CREATE EXTENSION IF NOT EXISTS vector');
} catch {
  pgAvailable = false;
} finally {
  await probe.end().catch(() => undefined);
}

const OLLAMA_768 = { modelId: 'ollama:nomic-embed-text', dimensions: 768 };
const OPENAI_1536 = { modelId: 'openai:text-embedding-3-small', dimensions: 1536 };

const silent = (): void => undefined;
const VEC768 = `[${new Array(768).fill(0.01).join(',')}]`;

/** Advisory-lock namespace shared by the migration and `decideRegistry`. */
const LOCK_NS_REGISTRY = 4_400;

describe('#440 vector-column migration guards (real Postgres)', { skip: !pgAvailable }, () => {
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
   * Fresh tables per test, carrying the SHIPPED index shapes — including the
   * two partial indexes that mention `embedding` only in their predicate.
   */
  async function freshSchema(opts: {
    nodesWithVectors?: number;
    exhaustedNodes?: number;
    registry?: { modelId: string; dimensions: number; clearPending?: boolean; ageDays?: number };
  }): Promise<void> {
    await pool.query('DROP TABLE IF EXISTS graph_nodes, processes, graph_embedding_model');
    await pool.query(`
      CREATE TABLE graph_nodes (
        id                      TEXT PRIMARY KEY,
        tenant_id               TEXT NOT NULL,
        type                    TEXT,
        embedding               public.vector(768),
        embedding_attempts      INTEGER NOT NULL DEFAULT 0,
        embedding_last_error    TEXT,
        embedding_last_error_at TIMESTAMPTZ
      )`);
    await pool.query(`
      CREATE INDEX idx_graph_nodes_embedding
        ON graph_nodes USING hnsw (embedding public.vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)`);
    // 0006_embedding_backfill_state.sql:16 — keyed on (embedding_attempts, id),
    // mentions `embedding` ONLY in the partial predicate.
    await pool.query(`
      CREATE INDEX idx_graph_nodes_turn_embedding_pending
        ON graph_nodes (embedding_attempts, id)
        WHERE type = 'Turn' AND embedding IS NULL`);
    // 0022_kg_embedding_pending_indexes.sql:13 — same shape, MK type.
    await pool.query(`
      CREATE INDEX idx_graph_nodes_mk_embedding_pending
        ON graph_nodes (embedding_attempts, id)
        WHERE type = 'MemorableKnowledge' AND embedding IS NULL`);
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
        `INSERT INTO graph_nodes (id, tenant_id, type, embedding)
         VALUES ($1, $3, 'Turn', $2::public.vector)`,
        [`node:${String(i)}`, VEC768, TENANT],
      );
    }
    for (let i = 0; i < (opts.exhaustedNodes ?? 0); i++) {
      await pool.query(
        `INSERT INTO graph_nodes (id, tenant_id, type, embedding, embedding_attempts, embedding_last_error)
         VALUES ($1, $2, 'Turn', NULL, 5, 'old provider was down')`,
        [`exhausted:${String(i)}`, TENANT],
      );
    }
    if (opts.registry) {
      await pool.query(
        `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions, clear_pending, updated_at)
         VALUES ($5, $1, $2, $3, now() - ($4 || ' days')::interval)`,
        [
          opts.registry.modelId,
          opts.registry.dimensions,
          opts.registry.clearPending ?? false,
          String(opts.registry.ageDays ?? 1),
          TENANT,
        ],
      );
    }
  }

  const indexDef = async (name: string): Promise<string | undefined> => {
    const r = await pool.query<{ d: string }>(
      `SELECT pg_get_indexdef(i.oid) AS d
         FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace
        WHERE i.relname = $1 AND n.nspname = $2`,
      [name, SCHEMA],
    );
    return r.rows[0]?.d;
  };

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

  const spentCounters = async (): Promise<number> => {
    const r = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM graph_nodes WHERE embedding_attempts <> 0',
    );
    return Number(r.rows[0]?.n ?? 0);
  };

  // ── F1 ────────────────────────────────────────────────────────────────────

  describe('F1 — indexes referencing the column only in a predicate', () => {
    it('captures the shipped 0006/0022 partial indexes', async () => {
      await freshSchema({});
      const client = await pool.connect();
      try {
        const defs = await captureIndexDefs(client, {
          table: 'graph_nodes',
          column: 'embedding',
        });
        const names = defs
          .map((d) => /INDEX (\S+) ON/.exec(d)?.[1])
          .filter((n): n is string => n !== undefined)
          .sort();
        assert.deepEqual(names, [
          'idx_graph_nodes_embedding',
          'idx_graph_nodes_mk_embedding_pending',
          'idx_graph_nodes_turn_embedding_pending',
        ]);
        assert.ok(
          !names.includes('idx_graph_nodes_tenant'),
          'an index that does not reference the column must not be captured',
        );
      } finally {
        client.release();
      }
    });

    it('replays them byte-identically across the width migration', async () => {
      await freshSchema({
        nodesWithVectors: 3,
        registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
      });
      // These are the BACKFILL SCAN indexes: the sweep the migration itself
      // triggers depends on them, and `DROP COLUMN` auto-drops them with no
      // error and no CASCADE. Before the fix they were destroyed and never
      // replayed, while the migration reported ok:true.
      const turnBefore = await indexDef('idx_graph_nodes_turn_embedding_pending');
      const mkBefore = await indexDef('idx_graph_nodes_mk_embedding_pending');
      assert.ok(turnBefore !== undefined && mkBefore !== undefined);

      const outcome = await evaluateEmbeddingModelGate({
        pool,
        tenantId: TENANT,
        provider: OPENAI_1536,
        allowDestructiveColumnMigration: true,
        log: silent,
      });
      assert.equal(outcome.status, 'column-migrated');
      assert.equal(await declaredType('graph_nodes'), 'public.vector(1536)');

      assert.equal(
        await indexDef('idx_graph_nodes_turn_embedding_pending'),
        turnBefore,
        '0006 backfill scan index must survive with an identical definition',
      );
      assert.equal(
        await indexDef('idx_graph_nodes_mk_embedding_pending'),
        mkBefore,
        '0022 backfill scan index must survive with an identical definition',
      );
      assert.ok(
        (await indexDef('idx_graph_nodes_embedding')) !== undefined,
        'the HNSW key-column index must still be replayed too',
      );
      assert.ok(
        (await indexDef('idx_graph_nodes_tenant')) !== undefined,
        'an unrelated index must be left untouched',
      );

      if (outcome.status === 'column-migrated') {
        const nodes = outcome.migratedColumns.find((m) => m.table === 'graph_nodes');
        assert.equal(
          nodes?.indexes.length,
          3,
          'the reported index count must include the predicate ones',
        );
      }
    });

    it('captures an index that references the column only through an expression', async () => {
      await freshSchema({});
      await pool.query(
        `CREATE INDEX idx_graph_nodes_embed_expr ON graph_nodes ((embedding IS NULL), id)`,
      );
      const before = await indexDef('idx_graph_nodes_embed_expr');

      const outcome = await evaluateEmbeddingModelGate({
        pool,
        tenantId: TENANT,
        provider: OPENAI_1536,
        allowDestructiveColumnMigration: true,
        log: silent,
      });
      assert.equal(outcome.status, 'column-migrated');
      assert.equal(await indexDef('idx_graph_nodes_embed_expr'), before);
    });
  });

  // ── F2 ────────────────────────────────────────────────────────────────────

  describe('F2 — the attempt reset is bounded', () => {
    it('caps the reset, records the remainder on clear_pending and refuses writes until it drains', async () => {
      await freshSchema({
        exhaustedNodes: 12,
        registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
      });

      // A cap far below the owed rows stands in for the real failing case:
      // ~1M rows with spent counters, where the unbounded UPDATE blew the 4s
      // statement_timeout, rolled the whole swap back and returned
      // ddl-failed → blocked, identically on every restart.
      const result = await migrateVectorColumns({
        pool,
        tenantId: TENANT,
        targets: [{ table: 'graph_nodes', column: 'embedding' }],
        targetModelId: OPENAI_1536.modelId,
        targetDimensions: 1536,
        switchCooldownMs: 0,
        attemptResetMaxRows: 5,
        log: silent,
      });

      assert.equal(result.ok, true, 'the swap must still succeed — it is metadata-only');
      if (!result.ok) return;
      assert.equal(result.attemptsResetPending, true);
      assert.equal(result.migrated[0]?.attemptsReset, 5, 'exactly the cap, no more');
      assert.equal(await declaredType('graph_nodes'), 'public.vector(1536)');
      assert.equal(await spentCounters(), 7, '12 owed − 5 done');

      // The remainder is durable, not dropped on the floor.
      const reg = await registryRow();
      assert.equal(reg?.dimensions, 1536);
      assert.equal(
        reg?.clear_pending,
        true,
        'clear_pending is what arms the two resumers that finish the reset',
      );

      // …and the existing bounded resumer finishes it, exactly as it does for
      // a same-width switch. No row is left permanently un-embeddable.
      const drained = await clearStaleVectors(pool, TENANT, {
        batchSize: 500,
        maxRows: 5_000,
        statementTimeoutMs: 15_000,
      });
      assert.equal(drained.attemptsReset, 7);
      assert.equal(drained.pending, false);
      assert.equal(await spentCounters(), 0);
      assert.equal((await registryRow())?.clear_pending, false);
    });

    it('drains in one pass and leaves writes ON when the corpus fits under the cap', async () => {
      await freshSchema({
        nodesWithVectors: 2,
        exhaustedNodes: 4,
        registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
      });

      const outcome = await evaluateEmbeddingModelGate({
        pool,
        tenantId: TENANT,
        provider: OPENAI_1536,
        allowDestructiveColumnMigration: true,
        log: silent,
      });

      assert.equal(outcome.status, 'column-migrated');
      if (outcome.status === 'column-migrated') {
        assert.equal(outcome.clearPending, false);
      }
      assert.equal(
        allowsVectorWrites(outcome),
        true,
        'the ordinary case must not pay for the large-tenant guard',
      );
      assert.equal(await spentCounters(), 0);
      assert.equal((await registryRow())?.clear_pending, false);
    });

    it('does not livelock: the swap never rolls back over the reset', async () => {
      await freshSchema({
        exhaustedNodes: 40,
        registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
      });

      // A statement_timeout tight enough that an unbounded full-table UPDATE
      // would be at risk, with a cap of 1 row per run. Every activation must
      // still complete the swap rather than rolling it back to the old width.
      const result = await migrateVectorColumns({
        pool,
        tenantId: TENANT,
        targets: [{ table: 'graph_nodes', column: 'embedding' }],
        targetModelId: OPENAI_1536.modelId,
        targetDimensions: 1536,
        switchCooldownMs: 0,
        attemptResetMaxRows: 1,
        statementTimeoutMs: 4_000,
        log: silent,
      });

      assert.equal(result.ok, true);
      assert.equal(await declaredType('graph_nodes'), 'public.vector(1536)');
      assert.equal((await registryRow())?.dimensions, 1536, 'the registry moved too');
    });
  });

  // ── F3 ────────────────────────────────────────────────────────────────────

  describe('F3 — the session advisory lock never leaks', () => {
    /** Can an independent connection take the tenant's registry lock? */
    const lockIsFree = async (): Promise<boolean> => {
      const other = new Pool({ connectionString: PG_URL, max: 1 });
      try {
        const r = await other.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1::int, hashtext($2)::int) AS locked',
          [LOCK_NS_REGISTRY, TENANT],
        );
        return r.rows[0]?.locked === true;
      } finally {
        await other.end();
      }
    };

    it('releases it when a probe inside the locked region throws', async () => {
      await freshSchema({
        registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
      });
      assert.equal(await lockIsFree(), true, 'precondition: lock is free');

      // `readRegistryRow` is the FIRST statement inside the locked region and
      // it is not wrapped in anything — removing the table makes it throw for
      // real. `poisoned` was only ever set on the `migrateOneColumn` path, so
      // this throw ran the `finally`, swallowed the unlock's failure and
      // returned a connection that may still hold a SESSION-scoped lock to the
      // pool — after which `decideRegistry`'s BLOCKING pg_advisory_xact_lock
      // in this same namespace hangs forever rather than degrading.
      await pool.query('DROP TABLE graph_embedding_model');
      await assert.rejects(
        migrateVectorColumns({
          pool,
          tenantId: TENANT,
          targets: [{ table: 'graph_nodes', column: 'embedding' }],
          targetModelId: OPENAI_1536.modelId,
          targetDimensions: 1536,
          switchCooldownMs: 0,
          log: silent,
        }),
        /graph_embedding_model/,
      );

      assert.equal(
        await lockIsFree(),
        true,
        'the registry lock must be free again — a leaked one HANGS decideRegistry',
      );
    });

    it('releases it on the ordinary success path too', async () => {
      await freshSchema({
        nodesWithVectors: 1,
        registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 3 },
      });
      const result = await migrateVectorColumns({
        pool,
        tenantId: TENANT,
        targets: [{ table: 'graph_nodes', column: 'embedding' }],
        targetModelId: OPENAI_1536.modelId,
        targetDimensions: 1536,
        switchCooldownMs: 0,
        log: silent,
      });
      assert.equal(result.ok, true);
      assert.equal(await lockIsFree(), true);
    });

    it('a second gate evaluation still works after a throwing one', async () => {
      // The observable consequence of the leak: the very next gate evaluation
      // took a blocking xact lock in the same namespace and never returned.
      const outcome = await evaluateEmbeddingModelGate({
        pool,
        tenantId: TENANT,
        provider: OPENAI_1536,
        allowDestructiveColumnMigration: true,
        log: silent,
      });
      assert.ok(outcome.status !== 'blocked' || outcome.reason !== 'registry-conflict');
    });
  });

  // ── F4 ────────────────────────────────────────────────────────────────────

  describe('F4 — the cooldown survives the migration it guards', () => {
    it('refuses an immediate migration back, even though the columns are now empty', async () => {
      await freshSchema({
        nodesWithVectors: 3,
        registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 1 },
      });

      const first = await evaluateEmbeddingModelGate({
        pool,
        tenantId: TENANT,
        provider: OPENAI_1536,
        allowDestructiveColumnMigration: true,
        log: silent,
      });
      assert.equal(first.status, 'column-migrated');
      assert.equal(await declaredType('graph_nodes'), 'public.vector(1536)');

      // 0s elapsed, cooldown 600s. The previous migration re-created the
      // columns EMPTY, so the old `hasAnyVector(targets)` conjunct read false
      // and the guard never fired: the second provider migrated straight back
      // to 768. Two machine versions in a rolling deploy therefore alternately
      // dropped both governed columns, each cycle burning paid API calls on
      // rows the next cycle discarded.
      const second = await evaluateEmbeddingModelGate({
        pool,
        tenantId: TENANT,
        provider: OLLAMA_768,
        allowDestructiveColumnMigration: true,
        log: silent,
      });

      assert.equal(second.status, 'blocked');
      if (second.status === 'blocked') {
        assert.equal(second.reason, 'column-width-mismatch');
      }
      assert.equal(
        await declaredType('graph_nodes'),
        'public.vector(1536)',
        'the columns must NOT have been rewritten a second time',
      );
      assert.equal((await registryRow())?.dimensions, 1536);
    });

    it('still allows the migration once the cooldown has elapsed', async () => {
      // Same tables, registry aged past the window: the guard is a cooldown,
      // not a one-way door.
      await pool.query(
        `UPDATE graph_embedding_model SET updated_at = now() - interval '2 days'`,
      );
      const outcome = await evaluateEmbeddingModelGate({
        pool,
        tenantId: TENANT,
        provider: OLLAMA_768,
        allowDestructiveColumnMigration: true,
        log: silent,
      });
      assert.equal(outcome.status, 'column-migrated');
      assert.equal(await declaredType('graph_nodes'), 'public.vector(768)');
      assert.equal((await registryRow())?.dimensions, 768);
    });

    it('a zero cooldown disables the guard, unchanged', async () => {
      await freshSchema({
        nodesWithVectors: 1,
        registry: { modelId: OLLAMA_768.modelId, dimensions: 768, ageDays: 0 },
      });
      const result = await migrateVectorColumns({
        pool,
        tenantId: TENANT,
        targets: [{ table: 'graph_nodes', column: 'embedding' }],
        targetModelId: OPENAI_1536.modelId,
        targetDimensions: 1536,
        switchCooldownMs: 0,
        log: silent,
      });
      assert.equal(result.ok, true);
    });
  });
});
