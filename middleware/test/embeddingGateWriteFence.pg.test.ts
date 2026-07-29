import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import type { EmbeddingClient } from '@omadia/plugin-api';
import { Pool } from 'pg';

import {
  startEmbeddingBackfill,
  type EmbeddingBackfillHandle,
} from '@omadia/knowledge-graph-neon/dist/embeddingBackfill.js';
import {
  startGateRunner,
  type GateRunner,
} from '@omadia/knowledge-graph-neon/dist/gateReevaluation.js';
import { NeonKnowledgeGraph } from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { NeonProcessMemoryStore } from '@omadia/knowledge-graph-neon/dist/processMemoryStore.js';

/**
 * #440 follow-up — THE GATE EPOCH WRITE FENCE, against a REAL Postgres and a
 * REAL `EmbeddingBackfillHandle`.
 *
 * WHAT THIS SUITE EXISTS TO CATCH. `EmbeddingBackfillHandle.stop()` clears
 * timers and nothing else. A `runSweep()` already executing keeps its own
 * `running` flag, its own captured `embeddingClient` and its own batch, doing
 * one `await embed()` network round trip per row followed by
 * `UPDATE … SET embedding = $1::vector, embedding_attempts = 0`. A same-width
 * provider switch runs the whole clear/republish/re-arm dance INSIDE that
 * window, so the previous provider's vectors land after the clear drained —
 * `clear_pending` is FALSE so nothing will clear them, `embedding IS NOT NULL`
 * so no `WHERE embedding IS NULL` sweep revisits them, and `/health` reports
 * `embeddings: true` throughout. The invariant `clear_pending` rests on ("a
 * non-NULL vector is an old-model vector") is false from then on.
 *
 * `embeddingGateReevaluation.pg.test.ts` substitutes a RECORDING STUB for
 * `syncBackfill`, which is precisely why the delta's own tests miss this. Every
 * test here drives the real handle through the real `syncBackfill` shape from
 * `plugin.ts`, with an embed client the test can hold mid-call.
 *
 * Own schema AND own tenant id: the registry advisory lock is
 * `hashtext(tenantId)` and database-wide, so a tenant shared with a sibling
 * suite deadlocks under the parallel runner.
 */

const PG_URL =
  process.env['GRAPH_PG_TEST_URL'] ??
  process.env['MEMORY_PG_TEST_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://test:test@127.0.0.1:55438/test';

const SCHEMA = 'embgate_fence_test';
const TENANT = 'fence-440';

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

const silent = (): void => undefined;

/** Distinct fill values so a stored vector names the model that produced it. */
const MODEL_A_FILL = 0.25;
const MODEL_B_FILL = 0.5;

/**
 * An embedding client the test can hold mid-`embed()`.
 *
 * That hold IS the defect's window: the sweep and both hot-path writers resolve
 * their client, await this call, and only then write. Everything the switch
 * does — clear, republish, stop, re-arm — happens while this promise is
 * pending.
 */
class HeldEmbedder implements EmbeddingClient {
  readonly dimensions = 768;

  calls = 0;

  private release: (() => void) | null = null;

  private announceCall: (() => void) | null = null;

  private held = true;

  constructor(
    readonly modelId: string,
    private readonly fill: number,
  ) {}

  async embed(): Promise<number[]> {
    this.calls += 1;
    this.announceCall?.();
    this.announceCall = null;
    if (this.held) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return new Array(768).fill(this.fill);
  }

  /** Resolves once `embed()` has been entered — i.e. the window is open. */
  whenCalled(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.calls > 0 && this.release !== null) {
        resolve();
        return;
      }
      this.announceCall = resolve;
    });
  }

  /** Let the held call finish, and stop holding subsequent ones. */
  releaseAndRunFree(): void {
    this.held = false;
    const release = this.release;
    this.release = null;
    release?.();
  }

  /** Never hold at all — for the client that is supposed to succeed. */
  runFreeFromTheStart(): this {
    this.held = false;
    return this;
  }
}

describe('#440 gate-epoch write fence (real Postgres, real backfill handle)', { skip: !pgAvailable }, () => {
  let real: Pool;
  const openHandles: EmbeddingBackfillHandle[] = [];

  before(async () => {
    real = new Pool({
      connectionString: PG_URL,
      max: 8,
      // `public` stays on the path: the writers cast with a bare `::vector`,
      // and pgvector's type lives in `public` on this container.
      options: `-c search_path=${SCHEMA},public`,
    });
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
  });

  after(async () => {
    for (const handle of openHandles) handle.stop();
    await real.end();
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  /** Fresh 768-wide schema per test. Every test performs one model switch. */
  async function freshSchema(opts: {
    pendingTurns?: number;
    pendingProcesses?: number;
  }): Promise<void> {
    await real.query(
      'DROP TABLE IF EXISTS graph_nodes, processes, process_history, graph_embedding_model',
    );
    await real.query(`
      CREATE TABLE graph_nodes (
        id                      TEXT PRIMARY KEY,
        tenant_id               TEXT NOT NULL,
        type                    TEXT NOT NULL,
        external_id             TEXT,
        properties              JSONB NOT NULL DEFAULT '{}'::jsonb,
        embedding               public.vector(768),
        embedding_attempts      INTEGER NOT NULL DEFAULT 0,
        embedding_last_error    TEXT,
        embedding_last_error_at TIMESTAMPTZ,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await real.query(`
      CREATE TABLE processes (
        id         TEXT NOT NULL,
        tenant_id  TEXT NOT NULL,
        scope      TEXT NOT NULL DEFAULT 'team',
        title      TEXT NOT NULL,
        steps      JSONB NOT NULL DEFAULT '[]'::jsonb,
        visibility TEXT NOT NULL DEFAULT 'team',
        embedding  public.vector(768),
        version    INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id)
      )`);
    await real.query(`
      CREATE TABLE process_history (
        id            TEXT NOT NULL,
        tenant_id     TEXT NOT NULL,
        version       INTEGER NOT NULL,
        title         TEXT NOT NULL,
        steps         JSONB NOT NULL,
        visibility    TEXT NOT NULL,
        superseded_at TIMESTAMPTZ NOT NULL
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
    for (let i = 0; i < (opts.pendingTurns ?? 0); i++) {
      await real.query(
        `INSERT INTO graph_nodes (id, tenant_id, type, external_id, properties)
         VALUES ($1, $2, 'Turn', $3, $4::jsonb)`,
        [
          `00000000-0000-4000-8000-00000000000${String(i)}`,
          TENANT,
          `turn:${String(i)}`,
          JSON.stringify({ userMessage: `q${String(i)}`, assistantAnswer: `a${String(i)}` }),
        ],
      );
    }
    for (let i = 0; i < (opts.pendingProcesses ?? 0); i++) {
      await real.query(
        `INSERT INTO processes (id, tenant_id, title, steps)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [`proc:${String(i)}`, TENANT, `Backend: step ${String(i)}`, JSON.stringify(['do it'])],
      );
    }
    // Three days old: the switch cooldown guards a rolling deploy, not a test.
    await real.query(
      `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions, updated_at)
       VALUES ($1, 'ollama:nomic-embed-text', 768, now() - interval '3 days')`,
      [TENANT],
    );
  }

  const storedVectors = async (table: string): Promise<string[]> => {
    const r = await real.query<{ v: string }>(
      `SELECT embedding::text AS v FROM ${table} WHERE embedding IS NOT NULL`,
    );
    return r.rows.map((row) => row.v);
  };

  const attemptCounters = async (): Promise<number[]> => {
    const r = await real.query<{ n: number }>(
      'SELECT embedding_attempts AS n FROM graph_nodes WHERE tenant_id = $1',
      [TENANT],
    );
    return r.rows.map((row) => Number(row.n));
  };

  /**
   * The plugin's own wiring, verbatim in shape: ONE `syncBackfill` that stops
   * the outgoing handle and constructs a real replacement, handed to
   * `startGateRunner` and called once at boot exactly as `plugin.ts` does.
   */
  async function startPluginLikeRuntime(initialClient: EmbeddingClient): Promise<{
    runner: GateRunner;
    setRegistryClient: (c: EmbeddingClient) => void;
    currentHandle: () => EmbeddingBackfillHandle | undefined;
    resolveEmbeddingClient: () => EmbeddingClient | undefined;
  }> {
    let registryClient: EmbeddingClient = initialClient;
    let runner: GateRunner | undefined;
    let handle: EmbeddingBackfillHandle | undefined;
    let handleClient: EmbeddingClient | undefined;

    const syncBackfill = (args: {
      client: EmbeddingClient | undefined;
      vectorWritesAllowed: boolean;
      clearResumeOwed: boolean;
    }): void => {
      const wanted =
        args.vectorWritesAllowed || args.clearResumeOwed ? args.client : undefined;
      if (handle !== undefined && handleClient === wanted) return;
      if (handle !== undefined) {
        handle.stop();
        handle = undefined;
        handleClient = undefined;
      }
      if (!wanted) return;
      handle = startEmbeddingBackfill({
        pool: real,
        embeddingClient: wanted,
        tenantId: TENANT,
        // Long enough that only the explicit `runOnce()` calls below ever run.
        intervalMs: 3_600_000,
        batchSize: 20,
        maxAttempts: 5,
        nodeTypes: ['Turn'],
        includeProcesses: true,
        resumeStaleVectorClear: true,
        onStaleVectorClearComplete: (sweepEpoch) => {
          runner?.markStaleVectorClearComplete(sweepEpoch);
        },
        gateEpoch: () => runner?.epoch() ?? 0,
        log: silent,
      });
      handleClient = wanted;
      openHandles.push(handle);
    };

    runner = await startGateRunner({
      pool: real,
      tenantId: TENANT,
      resolveRegistryClient: () => registryClient,
      autoMigrateVectorColumns: true,
      syncBackfill,
      log: silent,
    });
    // `plugin.ts` arms the boot verdict itself; the runner only re-syncs.
    syncBackfill({
      client: runner.approvedClient(),
      vectorWritesAllowed: runner.vectorWritesAllowed(),
      clearResumeOwed: runner.clearResumeOwed(),
    });

    const activeRunner = runner;
    return {
      runner: activeRunner,
      setRegistryClient: (c) => {
        registryClient = c;
      },
      currentHandle: () => handle,
      // Verbatim the expression in plugin.ts.
      resolveEmbeddingClient: () =>
        activeRunner.vectorWritesAllowed() ? activeRunner.approvedClient() : undefined,
    };
  }

  it('an in-flight sweep writes NOTHING after a switch replaced it', async () => {
    // THE BLOCKING CASE. A backlog is exactly why an operator switches
    // provider, so "a sweep is mid-batch during the switch" is the likely
    // state, not the exotic one.
    await freshSchema({ pendingTurns: 4, pendingProcesses: 2 });
    const modelA = new HeldEmbedder('ollama:nomic-embed-text', MODEL_A_FILL);
    const modelB = new HeldEmbedder('ollama:mxbai-embed-768', MODEL_B_FILL).runFreeFromTheStart();

    const rt = await startPluginLikeRuntime(modelA);
    assert.equal(rt.runner.outcome().status, 'match', 'precondition: a healthy 768 world');
    const sweepOne = rt.currentHandle();
    assert.ok(sweepOne, 'the boot verdict must arm a real sweep');

    // Sweep S1 starts and blocks inside `embed()` on its first row.
    const inFlight = sweepOne.runOnce();
    await modelA.whenCalled();
    assert.equal(modelA.calls, 1, 'S1 really is mid-batch, not finished');

    // The operator switches to another 768-wide provider. Same width ⇒ no
    // column moves: the registry flips, the clear drains, `clearPending` goes
    // false, writes are ALLOWED again, and `syncBackfill` stops S1 and builds
    // S2 around model B — all while S1 is still awaiting model A.
    rt.setRegistryClient(modelB);
    await rt.runner.reevaluate({ allowDestructiveMigration: true });
    assert.equal(rt.runner.vectorWritesAllowed(), true, 'the clear drained; writes are back ON');
    assert.equal(rt.resolveEmbeddingClient(), modelB);
    assert.notEqual(rt.currentHandle(), sweepOne, 'S1 was stood down and replaced');

    // Now let S1's held call return and finish its batch.
    modelA.releaseAndRunFree();
    const stats = await inFlight;

    assert.deepEqual(
      await storedVectors('graph_nodes'),
      [],
      'not one model-A vector may land after the clear drained — a row that ' +
        'did would be non-NULL under a registry naming model B, so no clear ' +
        'and no `WHERE embedding IS NULL` sweep would ever revisit it',
    );
    assert.deepEqual(await storedVectors('processes'), [], 'same for the second cosine space');
    assert.equal(stats.succeeded, 0);
    assert.ok(
      (stats.staleEpochSkipped ?? 0) >= 1,
      'the discard must be counted, not silent',
    );
    assert.deepEqual(
      await attemptCounters(),
      [0, 0, 0, 0],
      'a fenced write is a clean no-op: the row stays NULL and is NOT charged ' +
        'an attempt, because nothing about it was broken',
    );

    // …and the no-op really is recoverable: the replacement sweep re-picks
    // every one of those rows, because they are still NULL.
    const sweepTwo = rt.currentHandle();
    assert.ok(sweepTwo);
    const second = await sweepTwo.runOnce();
    assert.equal(second.succeeded, 6, '4 turns + 2 processes');
    const written = await storedVectors('graph_nodes');
    assert.equal(written.length, 4);
    for (const vector of written) {
      assert.ok(
        vector.startsWith(`[${String(MODEL_B_FILL)}`),
        'and what landed is model B, the provider the registry now names',
      );
    }
  });

  it('the hot-path turn embedder discards a vector a re-gate invalidated', async () => {
    // `neonKnowledgeGraph.embedAndStoreTurn` — resolve once, `await embed()`,
    // UPDATE. The resolve-once contract is correct and stays (re-resolving
    // between the guard and the embed turns a clean skip into a crash), so the
    // fence has to sit at the write.
    await freshSchema({ pendingTurns: 1 });
    const modelA = new HeldEmbedder('ollama:nomic-embed-text', MODEL_A_FILL);
    const modelB = new HeldEmbedder('ollama:mxbai-embed-768', MODEL_B_FILL).runFreeFromTheStart();
    const rt = await startPluginLikeRuntime(modelA);

    const graph = new NeonKnowledgeGraph({
      pool: real,
      tenantId: TENANT,
      resolveEmbeddingClient: rt.resolveEmbeddingClient,
      gateEpoch: () => rt.runner.epoch(),
    });
    // `embedAndStoreTurn` is private and fire-and-forget from `ingestTurn`.
    // Reached directly so the test drives the REAL writer and its REAL SQL
    // without standing up the whole ingest schema.
    const embedTurn = (
      graph as unknown as {
        embedAndStoreTurn(id: string, user: string, assistant: string): Promise<void>;
      }
    ).embedAndStoreTurn.bind(graph);

    const writing = embedTurn('00000000-0000-4000-8000-000000000000', 'q0', 'a0');
    await modelA.whenCalled();

    rt.setRegistryClient(modelB);
    await rt.runner.reevaluate({ allowDestructiveMigration: true });

    modelA.releaseAndRunFree();
    await writing;

    assert.deepEqual(
      await storedVectors('graph_nodes'),
      [],
      'the vector was computed by a client the current verdict no longer approves',
    );
    assert.deepEqual(
      await attemptCounters(),
      [0],
      'and the row was not charged an attempt — nothing about it failed',
    );
  });

  it('the hot-path node embedder discards a vector a re-gate invalidated', async () => {
    // `neonKnowledgeGraph.embedAndStoreNode` — the Slice-7 post-COMMIT
    // embedder for MemorableKnowledge / PalaiaExcerpt. Same shape, same window.
    await freshSchema({});
    await real.query(
      `INSERT INTO graph_nodes (id, tenant_id, type, external_id)
       VALUES ('11111111-0000-4000-8000-000000000000', $1, 'MemorableKnowledge', 'mk:1')`,
      [TENANT],
    );
    const modelA = new HeldEmbedder('ollama:nomic-embed-text', MODEL_A_FILL);
    const modelB = new HeldEmbedder('ollama:mxbai-embed-768', MODEL_B_FILL).runFreeFromTheStart();
    const rt = await startPluginLikeRuntime(modelA);

    const graph = new NeonKnowledgeGraph({
      pool: real,
      tenantId: TENANT,
      resolveEmbeddingClient: rt.resolveEmbeddingClient,
      gateEpoch: () => rt.runner.epoch(),
    });
    const embedNode = (
      graph as unknown as {
        embedAndStoreNode(externalId: string, text: string): Promise<void>;
      }
    ).embedAndStoreNode.bind(graph);

    const writing = embedNode('mk:1', 'a summary worth remembering');
    await modelA.whenCalled();

    rt.setRegistryClient(modelB);
    await rt.runner.reevaluate({ allowDestructiveMigration: true });

    modelA.releaseAndRunFree();
    await writing;

    assert.deepEqual(await storedVectors('graph_nodes'), []);
    assert.deepEqual(await attemptCounters(), [0]);
  });

  it('processMemory.write rejects rather than storing a vector a re-gate invalidated', async () => {
    // `processes.embedding` is the second governed cosine space, and its write
    // path embeds inline. A fenced write here cannot silently store NULL —
    // Dedup-First-Write needs the vector — so it takes the store's existing
    // `embedding-unavailable` rejection, which every caller already handles.
    await freshSchema({});
    const modelA = new HeldEmbedder('ollama:nomic-embed-text', MODEL_A_FILL);
    const modelB = new HeldEmbedder('ollama:mxbai-embed-768', MODEL_B_FILL).runFreeFromTheStart();
    const rt = await startPluginLikeRuntime(modelA);

    const store = new NeonProcessMemoryStore({
      pool: real,
      tenantId: TENANT,
      resolveEmbeddingClient: rt.resolveEmbeddingClient,
      gateEpoch: () => rt.runner.epoch(),
    });

    const writing = store.write({
      scope: 'backend',
      title: 'Backend: deploy to staging',
      steps: ['build', 'push'],
    });
    await modelA.whenCalled();

    rt.setRegistryClient(modelB);
    await rt.runner.reevaluate({ allowDestructiveMigration: true });

    modelA.releaseAndRunFree();
    const result = await writing;

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'embedding-unavailable');
    const rows = await real.query('SELECT id FROM processes WHERE tenant_id = $1', [TENANT]);
    assert.equal(
      rows.rows.length,
      0,
      'nothing was written — the caller can simply retry against the new provider',
    );
  });

  it('processMemory.edit rolls back rather than storing a vector a re-gate invalidated', async () => {
    // `edit` is the widest window of the four writers: it resolves its client,
    // opens a transaction, snapshots history, and only THEN embeds. A commit
    // here would store a previous-provider vector AND bump the version behind
    // it; the ROLLBACK makes the fenced write a clean no-op on both counts.
    await freshSchema({});
    await real.query(
      `INSERT INTO processes (id, tenant_id, title, steps, embedding)
       VALUES ('proc:edit', $1, 'Backend: deploy to staging', $2::jsonb, NULL)`,
      [TENANT, JSON.stringify(['build'])],
    );
    const modelA = new HeldEmbedder('ollama:nomic-embed-text', MODEL_A_FILL);
    const modelB = new HeldEmbedder('ollama:mxbai-embed-768', MODEL_B_FILL).runFreeFromTheStart();
    const rt = await startPluginLikeRuntime(modelA);

    const store = new NeonProcessMemoryStore({
      pool: real,
      tenantId: TENANT,
      resolveEmbeddingClient: rt.resolveEmbeddingClient,
      gateEpoch: () => rt.runner.epoch(),
    });

    const editing = store.edit({ id: 'proc:edit', steps: ['build', 'push'] });
    await modelA.whenCalled();

    rt.setRegistryClient(modelB);
    await rt.runner.reevaluate({ allowDestructiveMigration: true });

    modelA.releaseAndRunFree();
    const result = await editing;

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'embedding-unavailable');
    assert.deepEqual(await storedVectors('processes'), []);
    const row = await real.query<{ version: number; steps: unknown }>(
      'SELECT version, steps FROM processes WHERE tenant_id = $1 AND id = $2',
      [TENANT, 'proc:edit'],
    );
    assert.equal(Number(row.rows[0]?.version), 1, 'the version bump was rolled back too');
    const history = await real.query('SELECT id FROM process_history WHERE tenant_id = $1', [
      TENANT,
    ]);
    assert.equal(history.rows.length, 0, 'and so was the history snapshot');
  });
});
