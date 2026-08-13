import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/plugin-api';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { startGateRunner } from '@omadia/knowledge-graph-neon/dist/gateReevaluation.js';

/**
 * #440 follow-up — the in-place gate re-evaluation, against a REAL Postgres.
 *
 * Two decisions are under test here and they are easy to confuse:
 *
 *  1. A LIVE PROVIDER SWITCH MUST NOT TEAR THE KNOWLEDGE GRAPH DOWN. The admin
 *     route used to re-run the gate by re-activating the plugin, which calls
 *     `close()`, which calls `graphPool.end()` — on the pool the kernel
 *     captured once and shares with ~40 subsystems. So the pool here is wrapped
 *     in a spy: `end()` must never be reached, and the pool must still answer
 *     queries afterwards.
 *
 *     The subtle half is WHICH CLIENT EMBEDS. The plugin used to close over the
 *     client it resolved at activation, so a switch could leave the registry
 *     holding the new provider while the graph kept calling the old one, with
 *     nothing throwing anywhere. `approvedClient()` is asserted on every path.
 *
 *  2. THE DESTRUCTIVE COLUMN REWRITE IS NOT A BOOT BEHAVIOUR. `startGateRunner`
 *     is the activation path and never asks for the capability, so a width
 *     mismatch stays `blocked/column-width-mismatch` no matter what
 *     `auto_migrate_vector_columns` says. Only a confirmed switch —
 *     `reevaluate({ allowDestructiveMigration: true })` — may rewrite, and the
 *     master switch can still forbid even that.
 *
 * Own schema AND own tenant id: the registry advisory lock is
 * `hashtext(tenantId)` and database-wide, so a tenant shared with a sibling
 * suite deadlocks under the parallel runner.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'embeddingGateReevaluation',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  requireVector: true,
  timeoutMs: 1_500,
});

const SCHEMA = 'embgate_reeval_test';
const TENANT = 'reeval-440';

const silent = (): void => undefined;
const VEC768 = `[${new Array(768).fill(0.01).join(',')}]`;

const client = (modelId: string, dimensions: number): EmbeddingClient =>
  ({ modelId, dimensions, embed: async () => [] }) as unknown as EmbeddingClient;

const OLLAMA = client('ollama:nomic-embed-text', 768);
/** A second 768-wide provider: a same-width switch, so no column moves. */
const OLLAMA_ALT = client('ollama:mxbai-embed-768', 768);
const OPENAI = client('openai:text-embedding-3-small', 1536);

/** Records `end()` instead of performing it — see (1) in the header. */
function endSpy(real: Pool): { pool: Pool; endCalls: () => number } {
  let calls = 0;
  const wrapper = {
    query: (...args: unknown[]) =>
      (real.query as (...a: unknown[]) => unknown)(...args),
    connect: () => real.connect(),
    end: async (): Promise<void> => {
      calls += 1;
    },
  };
  return { pool: wrapper as unknown as Pool, endCalls: () => calls };
}

interface BackfillCall {
  clientModelId: string | null;
  vectorWritesAllowed: boolean;
  clearResumeOwed: boolean;
}

describe('#440 in-place gate re-evaluation (real Postgres)', { skip: !pgAvailable }, () => {
  let real: Pool;

  before(async () => {
    real = new Pool({
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
    await real.end();
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  /** Fresh 768-wide schema per test — these cases mutate column widths. */
  async function freshSchema(opts: {
    nodesWithVectors?: number;
    registry?: { modelId: string; dimensions: number; ageDays?: number };
  }): Promise<void> {
    await real.query('DROP TABLE IF EXISTS graph_nodes, processes, graph_embedding_model');
    await real.query(`
      CREATE TABLE graph_nodes (
        id                      TEXT PRIMARY KEY,
        tenant_id               TEXT NOT NULL,
        embedding               public.vector(768),
        embedding_attempts      INTEGER NOT NULL DEFAULT 0,
        embedding_last_error    TEXT,
        embedding_last_error_at TIMESTAMPTZ
      )`);
    await real.query(`
      CREATE INDEX idx_graph_nodes_embedding
        ON graph_nodes USING hnsw (embedding public.vector_cosine_ops)`);
    await real.query(`
      CREATE TABLE processes (
        id         TEXT NOT NULL,
        tenant_id  TEXT NOT NULL,
        embedding  public.vector(768),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id)
      )`);
    await real.query(`
      CREATE TABLE graph_embedding_model (
        tenant_id     TEXT PRIMARY KEY,
        model_id      TEXT        NOT NULL,
        dimensions    INTEGER     NOT NULL,
        clear_pending BOOLEAN     NOT NULL DEFAULT FALSE,
        recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    for (let i = 0; i < (opts.nodesWithVectors ?? 0); i++) {
      await real.query(
        'INSERT INTO graph_nodes (id, tenant_id, embedding) VALUES ($1, $2, $3::public.vector)',
        [`node:${String(i)}`, TENANT, VEC768],
      );
    }
    if (opts.registry) {
      await real.query(
        `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions, updated_at)
         VALUES ($1, $2, $3, now() - ($4 || ' days')::interval)`,
        [
          TENANT,
          opts.registry.modelId,
          opts.registry.dimensions,
          String(opts.registry.ageDays ?? 3),
        ],
      );
    }
  }

  const declaredType = async (table: string): Promise<string | undefined> => {
    const r = await real.query<{ t: string }>(
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

  const countVectors = async (table: string): Promise<number> => {
    const r = await real.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} WHERE embedding IS NOT NULL`,
    );
    return Number(r.rows[0]?.n ?? 0);
  };

  const registryRow = async (): Promise<
    { model_id: string; dimensions: number } | undefined
  > => {
    const r = await real.query<{ model_id: string; dimensions: number }>(
      'SELECT model_id, dimensions FROM graph_embedding_model WHERE tenant_id = $1',
      [TENANT],
    );
    return r.rows[0];
  };

  /** The runner plus everything a test needs to observe around it. */
  async function startRunner(opts: {
    initialClient: EmbeddingClient | undefined;
    autoMigrateVectorColumns?: boolean;
    /** Make `syncBackfill` throw — see the BLOCKING-3 case below. */
    syncBackfillThrows?: boolean;
  }): Promise<{
    runner: Awaited<ReturnType<typeof startGateRunner>>;
    setRegistryClient: (c: EmbeddingClient | undefined) => void;
    backfillCalls: BackfillCall[];
    endCalls: () => number;
    /** What the plugin's `resolveEmbeddingClient` would hand the stores. */
    resolveEmbeddingClient: () => EmbeddingClient | undefined;
  }> {
    let registryClient = opts.initialClient;
    const backfillCalls: BackfillCall[] = [];
    const { pool, endCalls } = endSpy(real);
    const runner = await startGateRunner({
      pool,
      tenantId: TENANT,
      resolveRegistryClient: () => registryClient,
      autoMigrateVectorColumns: opts.autoMigrateVectorColumns ?? true,
      syncBackfill: (args) => {
        backfillCalls.push({
          clientModelId:
            (args.client as { modelId?: string } | undefined)?.modelId ?? null,
          vectorWritesAllowed: args.vectorWritesAllowed,
          clearResumeOwed: args.clearResumeOwed,
        });
        if (opts.syncBackfillThrows === true) {
          throw new Error('could not arm the backfill sweep');
        }
      },
      log: silent,
    });
    return {
      runner,
      setRegistryClient: (c) => {
        registryClient = c;
      },
      backfillCalls,
      endCalls,
      // Verbatim the expression in plugin.ts.
      resolveEmbeddingClient: () =>
        runner.vectorWritesAllowed() ? runner.approvedClient() : undefined,
    };
  }

  it('a switch changes WHICH client actually embeds, without ending the pool', async () => {
    await freshSchema({
      nodesWithVectors: 2,
      registry: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
    });
    const h = await startRunner({ initialClient: OLLAMA });

    assert.equal(h.runner.outcome().status, 'match');
    assert.equal(h.resolveEmbeddingClient(), OLLAMA, 'precondition');

    // The provider plugin was swapped underneath: the REGISTRY now holds a
    // different client. Before the re-evaluate entry point the graph kept the
    // one it captured at activation, so the switch reported success and every
    // subsequent embed still went to the previous provider.
    h.setRegistryClient(OLLAMA_ALT);
    await h.runner.reevaluate({ allowDestructiveMigration: true });

    assert.equal(
      h.runner.approvedClient(),
      OLLAMA_ALT,
      'the gate must approve the client the registry now holds',
    );
    assert.equal(
      h.resolveEmbeddingClient(),
      OLLAMA_ALT,
      'and the stores must be handed it — otherwise the switch is cosmetic',
    );
    assert.equal((await registryRow())?.model_id, 'ollama:mxbai-embed-768');

    // Same width, so no column moved — but the old corpus was cleared for
    // re-embed, which is what a same-width switch has always done.
    assert.equal(await declaredType('graph_nodes'), 'public.vector(768)');

    // THE non-negotiable: nothing was torn down.
    assert.equal(h.endCalls(), 0, 'the shared pg pool must never be ended by a switch');
    assert.equal(
      (await real.query('SELECT 1 AS ok')).rows.length,
      1,
      'and it must still answer queries',
    );
  });

  it('republishes the verdict and re-arms the backfill with the new client', async () => {
    await freshSchema({
      nodesWithVectors: 1,
      registry: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
    });
    const h = await startRunner({ initialClient: OLLAMA });

    const published = h.runner.status;
    assert.equal(published.status, 'match');
    assert.equal(published.vectorWritesAllowed, true);

    h.setRegistryClient(OLLAMA_ALT);
    await h.runner.reevaluate({ allowDestructiveMigration: true });

    // Same object identity — the kernel and /health hold ONE reference.
    assert.equal(h.runner.status, published, 'the published object identity is stable');
    assert.match(
      String(published.activeModelId),
      /mxbai-embed-768/,
      'and its fields describe the NEW verdict',
    );

    assert.equal(h.backfillCalls.length, 1, 'the sweep is synced exactly once per re-gate');
    assert.equal(h.backfillCalls[0]?.clientModelId, 'ollama:mxbai-embed-768');
    assert.equal(h.endCalls(), 0);
  });

  it('stands the backfill down when the new verdict blocks', async () => {
    await freshSchema({
      nodesWithVectors: 1,
      registry: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
    });
    const h = await startRunner({
      initialClient: OLLAMA,
      // Master switch off: the confirmed switch below is refused, so the new
      // verdict is `blocked` and the sweep has nothing left to do.
      autoMigrateVectorColumns: false,
    });

    h.setRegistryClient(OPENAI);
    await h.runner.reevaluate({ allowDestructiveMigration: true });

    assert.equal(h.runner.outcome().status, 'blocked');
    assert.equal(h.runner.vectorWritesAllowed(), false);
    assert.equal(
      h.resolveEmbeddingClient(),
      undefined,
      'a blocked verdict hands the stores nothing, so they store NULL and fall back to FTS',
    );
    assert.equal(h.backfillCalls.length, 1);
    assert.equal(h.backfillCalls[0]?.vectorWritesAllowed, false);
    assert.equal(h.backfillCalls[0]?.clearResumeOwed, false);
    assert.equal(h.endCalls(), 0);
  });

  it('BLOCKS a width mismatch on the boot path and drops nothing, flag or no flag', async () => {
    // THE Decision-2 case. A deployment sitting on the documented
    // `blocked/column-width-mismatch` (768-wide columns, a 1536-wide provider)
    // upgrades and restarts. The rewrite is destructive and there is no
    // operator in the loop on this path, so it must not happen — even with
    // `auto_migrate_vector_columns` at its default 'true'.
    for (const autoMigrateVectorColumns of [true, false]) {
      await freshSchema({
        nodesWithVectors: 3,
        registry: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
      });

      const h = await startRunner({
        initialClient: OPENAI,
        autoMigrateVectorColumns,
      });

      const outcome = h.runner.outcome();
      assert.equal(
        outcome.status,
        'blocked',
        `auto_migrate_vector_columns=${String(autoMigrateVectorColumns)} must not make a restart destructive`,
      );
      if (outcome.status === 'blocked') {
        assert.equal(outcome.reason, 'column-width-mismatch');
      }
      assert.equal(h.runner.vectorWritesAllowed(), false);
      assert.equal(h.resolveEmbeddingClient(), undefined);

      assert.equal(await declaredType('graph_nodes'), 'public.vector(768)');
      assert.equal(await declaredType('processes'), 'public.vector(768)');
      assert.equal(await countVectors('graph_nodes'), 3, 'not one vector may be dropped');
      const reg = await registryRow();
      assert.equal(reg?.model_id, 'ollama:nomic-embed-text', 'the registry stays untouched');
      assert.equal(reg?.dimensions, 768);
    }
  });

  it('runs the migration for a CONFIRMED switch, still without ending the pool', async () => {
    // Same starting point as the boot case above, one difference: an operator
    // ticked `confirmDiscardVectors` in the admin UI, so the route hands the
    // capability to this one evaluation.
    await freshSchema({
      nodesWithVectors: 3,
      registry: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
    });
    const h = await startRunner({ initialClient: OLLAMA });
    assert.equal(h.runner.outcome().status, 'match', 'precondition: a healthy 768 world');

    h.setRegistryClient(OPENAI);
    await h.runner.reevaluate({ allowDestructiveMigration: true });

    const outcome = h.runner.outcome();
    assert.equal(outcome.status, 'column-migrated');
    assert.equal(h.runner.vectorWritesAllowed(), true);
    assert.equal(h.resolveEmbeddingClient(), OPENAI, 'the new provider is what embeds now');

    assert.equal(await declaredType('graph_nodes'), 'public.vector(1536)');
    assert.equal(await declaredType('processes'), 'public.vector(1536)');
    assert.equal(await countVectors('graph_nodes'), 0, 'the corpus was deliberately discarded');
    const reg = await registryRow();
    assert.equal(reg?.model_id, 'openai:text-embedding-3-small');
    assert.equal(reg?.dimensions, 1536);

    assert.equal(h.backfillCalls.at(-1)?.clientModelId, 'openai:text-embedding-3-small');
    assert.equal(h.endCalls(), 0, 'a migration is still not a reason to end the shared pool');
  });

  it('lets the master switch forbid the rewrite even for a confirmed switch', async () => {
    await freshSchema({
      nodesWithVectors: 3,
      registry: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
    });
    const h = await startRunner({
      initialClient: OLLAMA,
      autoMigrateVectorColumns: false,
    });

    h.setRegistryClient(OPENAI);
    await h.runner.reevaluate({ allowDestructiveMigration: true });

    const outcome = h.runner.outcome();
    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') {
      assert.equal(outcome.reason, 'column-width-mismatch');
    }
    assert.equal(await declaredType('graph_nodes'), 'public.vector(768)');
    assert.equal(await countVectors('graph_nodes'), 3);
    assert.equal((await registryRow())?.dimensions, 768);
  });

  it('never leaves writes ON with no sweep armed when arming the sweep throws', async () => {
    // BLOCKING-3. The order was `approved = nextClient` → `republish` →
    // `syncBackfill`, with nothing around the last call. A throw propagated out
    // of `reevaluate` AFTER the permitting verdict was published and AFTER the
    // previous sweep had been stopped and `backfill`/`backfillClient` cleared:
    // writes ON, nothing re-earning the corpus, and the admin route telling the
    // operator the switch failed.
    await freshSchema({
      nodesWithVectors: 1,
      registry: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
    });
    const h = await startRunner({
      initialClient: OLLAMA,
      syncBackfillThrows: true,
    });
    assert.equal(h.runner.vectorWritesAllowed(), true, 'precondition');
    const epochBefore = h.runner.epoch();

    h.setRegistryClient(OLLAMA_ALT);
    await assert.rejects(
      h.runner.reevaluate({ allowDestructiveMigration: true }),
      /could not arm the backfill sweep/,
      'the caller must still be told the switch failed',
    );

    // The sweep WAS asked for — this is the real failure, not a skipped call.
    assert.equal(h.backfillCalls.length, 1);
    assert.equal(h.backfillCalls[0]?.vectorWritesAllowed, true);

    // …and the published verdict now agrees with what the caller was told.
    assert.equal(
      h.runner.vectorWritesAllowed(),
      false,
      'writes must not stay ON while nothing is armed to re-earn the corpus',
    );
    assert.equal(h.runner.outcome().status, 'blocked');
    assert.equal(h.runner.status.vectorWritesAllowed, false);
    assert.equal(
      h.resolveEmbeddingClient(),
      undefined,
      'and the stores must be handed nothing, so they store NULL and fall back to FTS',
    );
    assert.ok(
      h.runner.epoch() > epochBefore + 1,
      'the downgrade bumps the epoch again, so anything mid-embed under the ' +
        'permitting verdict is fenced too',
    );
    assert.equal(h.endCalls(), 0);
  });

  it('refuses to rewrite for an UNCONFIRMED re-evaluation, master switch on', async () => {
    // The rollback path calls `reevaluate({ allowDestructiveMigration: false })`
    // — it must be able to re-point the resolver without ever being able to
    // drop a column.
    await freshSchema({
      nodesWithVectors: 3,
      registry: { modelId: 'ollama:nomic-embed-text', dimensions: 768 },
    });
    const h = await startRunner({ initialClient: OLLAMA });

    h.setRegistryClient(OPENAI);
    await h.runner.reevaluate({ allowDestructiveMigration: false });

    assert.equal(h.runner.outcome().status, 'blocked');
    assert.equal(await declaredType('graph_nodes'), 'public.vector(768)');
    assert.equal(await countVectors('graph_nodes'), 3);
    assert.equal(h.endCalls(), 0);
  });
});
