/**
 * Spec 2042 §6 criterion 37 — "with the lock in place, semantic search and
 * the embedding backfill (as a maintenance run, stopped at its budget) work
 * through the gateway".
 *
 * Real pieces, gateway in `enforce`: the embedding client as the kernel
 * registry hands it out (`gateModelService`), the knowledge graph's real
 * backfill sweep (`startEmbeddingBackfill`) run through the kernel's
 * maintenance-run service shape (`createModelWorkRuns` with
 * `EMBEDDING_BACKFILL`), and the agent tool `search_turns_semantic`.
 *
 *   - the backfill embeds inside a maintenance run, writes the vectors, is
 *     recorded as `maintenance` and stops at its budget; no `complete` runs in
 *     it; without a maintenance run nothing is embedded;
 *   - semantic search embeds in the agent's turn context, charged to the agent;
 *     outside any context the gateway refuses it and the model is not called.
 */

import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';

import { admitModelCall } from '@omadia/llm-provider';
import { KnowledgeGraphTool } from '@omadia/orchestrator';
import type { EmbeddingClient, KnowledgeGraph } from '@omadia/plugin-api';
import { currentExecutionContext, resetModelGatewayForTests, runInExecutionContext, setModelGatewayMode } from '@omadia/usage-telemetry';
import { Pool } from 'pg';

import { startEmbeddingBackfill } from '@omadia/knowledge-graph-neon/dist/embeddingBackfill.js';

import { probePgTest } from './_helpers/pgTestDb.js';

import { gateModelService } from '../src/platform/modelGatewayServices.js';
import { EMBEDDING_BACKFILL } from '../src/platform/modelWorkKinds.js';
import { createModelWorkRuns, type ModelWorkKind } from '../src/platform/modelWorkRuns.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'embeddingUnderEnforce',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  requireVector: true,
  timeoutMs: 1_500,
});

const SCHEMA = `emb_enforce_${String(process.pid)}`;
const TENANT = 'emb-enforce';

/** The adapter's raw client: records the context of every call it really runs. */
class RecordingEmbedder implements EmbeddingClient {
  readonly dimensions = 8;
  readonly modelId = 'test-embed';
  readonly contexts: (string | undefined)[] = [];
  async embed(): Promise<number[]> {
    const ctx = currentExecutionContext();
    this.contexts.push(ctx ? `${ctx.kind}:${ctx.agentSlug ?? ''}` : undefined);
    return new Array(8).fill(0.5);
  }
}

afterEach(() => resetModelGatewayForTests());

describe('criterion 37: embeddings under enforce (pg)', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    const admin = new Pool({ connectionString: PG_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${SCHEMA},public` });
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await pool?.end();
  });

  async function freshTurns(count: number): Promise<void> {
    await pool.query(`DROP TABLE IF EXISTS ${SCHEMA}.graph_nodes`);
    await pool.query(`
      CREATE TABLE ${SCHEMA}.graph_nodes (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, type TEXT NOT NULL, external_id TEXT,
        properties JSONB NOT NULL DEFAULT '{}'::jsonb, embedding public.vector(8),
        embedding_attempts INTEGER NOT NULL DEFAULT 0, embedding_last_error TEXT,
        embedding_last_error_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for (let i = 0; i < count; i += 1) {
      await pool.query(
        `INSERT INTO ${SCHEMA}.graph_nodes (id, tenant_id, type, external_id, properties) VALUES ($1, $2, 'Turn', $1, $3)`,
        [`turn-${String(i)}`, TENANT, JSON.stringify({ userMessage: `Frage ${String(i)}`, assistantAnswer: `Antwort ${String(i)}` })],
      );
    }
  }

  const embedded = async (): Promise<number> =>
    Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${SCHEMA}.graph_nodes WHERE embedding IS NOT NULL`)).rows[0]?.n);

  function sweep(raw: RecordingEmbedder, asMaintenanceRun?: <T>(work: () => Promise<T>) => Promise<T>) {
    const handle = startEmbeddingBackfill({
      ...(asMaintenanceRun ? { asMaintenanceRun } : {}),
      pool,
      // What every consumer holds: the registry's gated wrapper.
      embeddingClient: gateModelService('embeddingClient', raw),
      tenantId: TENANT,
      intervalMs: 3_600_000,
      batchSize: 20,
      maxAttempts: 5,
      nodeTypes: ['Turn'],
      log: () => undefined,
    });
    return handle;
  }

  it('the backfill embeds as a maintenance run and writes its vectors', async () => {
    setModelGatewayMode('enforce');
    await freshTurns(3);
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    const raw = new RecordingEmbedder();
    const handle = sweep(raw, (work) => runs.run({ ...EMBEDDING_BACKFILL, kind: 'kg:embedding_backfill' }, undefined, work));
    try {
      await handle.runOnce();
    } finally {
      handle.stop();
    }
    assert.equal(await embedded(), 3);
    assert.deepEqual(raw.contexts, ['maintenance_run:', 'maintenance_run:', 'maintenance_run:'], 'every embed in the maintenance run');
    const [run] = await runs.list();
    assert.equal(run?.contextKind, 'maintenance_run');
    assert.equal(run?.modelCalls, 3);
  });

  it('the backfill stops at its budget; the rest waits for the next run', async () => {
    setModelGatewayMode('enforce');
    await freshTurns(4);
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    const small: ModelWorkKind = { ...EMBEDDING_BACKFILL, kind: 'kg:embedding_backfill', budgetCalls: 2 };
    const raw = new RecordingEmbedder();
    const handle = sweep(raw, (work) => runs.run(small, undefined, work));
    try {
      await handle.runOnce();
    } finally {
      handle.stop();
    }
    assert.equal(raw.contexts.length, 2, 'the model ran twice');
    assert.equal(await embedded(), 2);
  });

  it('a maintenance run embeds only: a complete inside it is refused', async () => {
    setModelGatewayMode('enforce');
    const runs = createModelWorkRuns({ operatorDailyCalls: 100, maintenanceDailyCalls: 100 });
    await assert.rejects(
      runs.run(EMBEDDING_BACKFILL, undefined, async () => admitModelCall('complete')),
      /operation_not_allowed|may not 'complete'/,
    );
  });

  it('without a maintenance run the sweep embeds nothing', async () => {
    setModelGatewayMode('enforce');
    await freshTurns(2);
    const raw = new RecordingEmbedder();
    // The knowledge graph plugin's shape when `maintenanceRun@1` is missing.
    const handle = sweep(raw, () => Promise.reject(new Error('maintenanceRun@1 is not available')));
    try {
      await handle.runOnce().catch(() => undefined);
    } finally {
      handle.stop();
    }
    assert.deepEqual(raw.contexts, []);
    assert.equal(await embedded(), 0);
  });

  it("semantic search embeds in the agent's turn, charged to it; outside any context the gateway refuses it", async () => {
    setModelGatewayMode('enforce');
    const raw = new RecordingEmbedder();
    const searched: unknown[] = [];
    const graph = {
      searchTurnsByEmbedding: async (q: unknown) => {
        searched.push(q);
        return [];
      },
    } as unknown as KnowledgeGraph;
    const tool = new KnowledgeGraphTool(graph, gateModelService('embeddingClient', raw));
    const input = { query: 'search_turns_semantic', text: 'Wer kümmert sich um Müller?' };

    const inTurn = await runInExecutionContext({ kind: 'agent_turn', ownerId: 'turn-1', agentSlug: 'hanna' }, () => tool.handle(input));
    assert.match(inTurn, /"mode":"embedding"/);
    assert.deepEqual(raw.contexts, ['agent_turn:hanna'], 'in the agent turn, charged to the agent');
    assert.equal(searched.length, 1);

    const outside = await tool.handle(input);
    assert.match(outside, /embedding failed/);
    assert.deepEqual(raw.contexts, ['agent_turn:hanna'], 'the model was not called again');
    assert.equal(searched.length, 1);
  });
});
