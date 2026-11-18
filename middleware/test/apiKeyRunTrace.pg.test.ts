import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';

import {
  NeonKnowledgeGraph,
  createNeonPool,
} from '@omadia/knowledge-graph-neon/dist/neonKnowledgeGraph.js';
import { runGraphMigrations } from '@omadia/knowledge-graph-neon/dist/migrator.js';
import type { ChatStreamEvent } from '@omadia/channel-sdk';
import type { LlmProvider, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { InMemoryMemoryStore } from '@omadia/memory';
import { NativeToolRegistry, Orchestrator, SessionLogger } from '@omadia/orchestrator';
import type { Pool } from 'pg';

import { createOrchestratorDispatcher } from '../src/channels/orchestratorDispatcher.js';
import { probePgTest } from './_helpers/pgTestDb.js';

// ---------------------------------------------------------------------------
// An API-key chat turn, end to end, read back from the graph.
//
// Found in the E2E test on main 1d8233ce: the turn ran the model and
// `query_knowledge_graph`, wrote a privacy receipt and streamed a `runTrace`
// with status `success` — and left no Run in the knowledge graph. The browser
// path stored its run. Two causes:
//
//   1. the dispatcher sends `channelKind: 'api'` for a `key:<uuid>` caller,
//      which the Neon schema rejected, so no User-Cluster was ever created;
//   2. the run trace carried `key:<uuid>` instead of the canonical id, so
//      `ingestRun` would have looked for the wrong cluster anyway.
//
// The streamed `runTrace` event proves nothing about persistence (it is
// emitted before, and independently of, the graph write), so every assertion
// here is a SQL readback of `graph_nodes` / `graph_edges`.
//
// Skips (loudly) without a reachable pgvector Postgres — see issue #572.
// ---------------------------------------------------------------------------

const TENANT = `api-run-trace-${Date.now()}`;

let pool: Pool | undefined;
let reachable = false;

const capabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const usage = { inputTokens: 40, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** First call: `query_knowledge_graph`. Second call: the answer. */
function scriptedProvider(answer: string): LlmProvider {
  const streams: LlmStreamEvent[][] = [
    [
      {
        type: 'final',
        response: {
          content: [
            { type: 'tool_call', id: 'tu-kg-1', name: 'query_knowledge_graph', input: { query: 'stats' } },
          ],
          finishReason: 'tool_calls',
          providerFinishReason: 'tool_use',
          model: 'scripted-model',
          usage,
        },
      } as LlmStreamEvent,
    ],
    [
      { type: 'text_delta', text: answer },
      {
        type: 'final',
        response: {
          content: [{ type: 'text', text: answer }],
          finishReason: 'stop',
          providerFinishReason: 'end_turn',
          model: 'scripted-model',
          usage,
        },
      } as LlmStreamEvent,
    ],
  ];
  let idx = 0;
  const take = (): LlmStreamEvent[] => {
    const events = streams[idx];
    if (!events) throw new Error(`no scripted stream for provider call ${String(idx + 1)}`);
    idx += 1;
    return events;
  };
  return {
    id: 'anthropic',
    capabilities,
    complete: async (): Promise<LlmResponse> =>
      Promise.resolve((take().at(-1) as { response: LlmResponse }).response),
    stream: (): AsyncIterable<LlmStreamEvent> => {
      const events = take();
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

interface NodeRow {
  id: string;
  external_id: string;
  user_id: string | null;
  properties: Record<string, unknown>;
}

/** Polls until the Run for `scopeLike` exists — the session logger may still be writing. */
async function waitForRun(scopeLike: string): Promise<NodeRow | undefined> {
  for (let i = 0; i < 50; i += 1) {
    const res = await pool!.query<NodeRow>(
      `SELECT id, external_id, user_id, properties FROM graph_nodes
        WHERE tenant_id = $1 AND type = 'Run' AND scope LIKE $2`,
      [TENANT, `%${scopeLike}%`],
    );
    if (res.rows[0]) return res.rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

describe('API-key turn · run trace persists under the canonical user', () => {
  before(async () => {
    const probe = await probePgTest({
      label: 'apiKeyRunTrace',
      vars: ['WS3_PG_URL', 'GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
      requireVector: true,
    });
    if (!probe.reachable) return;
    pool = createNeonPool(probe.url!, 4);
    try {
      await runGraphMigrations(pool);
      reachable = true;
    } catch {
      reachable = false;
      await pool.end().catch(() => undefined);
      pool = undefined;
    }
  });

  after(async () => {
    if (pool) {
      await pool
        .query(`DELETE FROM graph_edges WHERE tenant_id = $1`, [TENANT])
        .catch(() => undefined);
      await pool
        .query(`DELETE FROM graph_nodes WHERE tenant_id = $1`, [TENANT])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  it("creates the API channel identity with channelKind 'api'", async (t) => {
    if (!reachable) return t.skip('no pg');
    const kg = new NeonKnowledgeGraph({ pool: pool!, tenantId: TENANT });
    const keyId = `key:${randomUUID()}`;
    const first = await kg.resolveOrCreateChannelIdentity({ channelKind: 'api', channelUserId: keyId });
    const again = await kg.resolveOrCreateChannelIdentity({ channelKind: 'api', channelUserId: keyId });
    assert.ok(first.omadiaUserId, 'no canonical id for the API key');
    assert.equal(again.omadiaUserId, first.omadiaUserId, 'the same key resolved to two clusters');

    const row = await pool!.query<{ kind: string; cluster: string }>(
      `SELECT ci.properties->>'channelKind' AS kind, u.external_id AS cluster
         FROM graph_nodes ci
         JOIN graph_edges e ON e.from_node = ci.id AND e.type = 'IS_IDENTITY_OF'
         JOIN graph_nodes u ON u.id = e.to_node AND u.type = 'User'
        WHERE ci.tenant_id = $1 AND ci.type = 'ChannelIdentity'
          AND ci.properties->>'channelUserId' = $2`,
      [TENANT, keyId],
    );
    assert.equal(row.rows.length, 1, 'expected exactly one ChannelIdentity linked to a User-Cluster');
    assert.equal(row.rows[0]!.kind, 'api');
    assert.equal(row.rows[0]!.cluster, `user:${first.omadiaUserId}`);
  });

  it('persists Run, Turn and ToolCall of an API-key turn under the canonical user', async (t) => {
    if (!reachable) return t.skip('no pg');
    const kg = new NeonKnowledgeGraph({ pool: pool!, tenantId: TENANT });
    const keyId = `key:${randomUUID()}`;
    const sessionId = `api-sess-${randomUUID()}`;
    const answer = 'Der Graph ist erreichbar.';

    const orchestrator = new Orchestrator({
      provider: scriptedProvider(answer),
      model: 'scripted-model',
      maxTokens: 1024,
      maxToolIterations: 4,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      agentId: 'api-e2e',
      knowledgeGraph: kg,
      sessionLogger: new SessionLogger(new InMemoryMemoryStore(), kg),
    } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
    const dispatcher = createOrchestratorDispatcher({
      getChannelBlock: () => undefined,
      getAgentBundle: () => ({ agent: orchestrator }) as never,
    });

    const events = await collect(
      dispatcher.streamTurn({
        channelId: 'de.byte5.channel.api',
        scope: sessionId,
        userRef: { kind: 'custom', id: keyId },
        text: 'Was steht im Wissensgraphen?',
      }),
    );

    // The answer still arrives.
    const done = events.find((e) => e.type === 'done') as { answer?: string } | undefined;
    assert.ok(done, `no done event: ${events.map((e) => e.type).join(',')}`);
    // The AI-disclosure line (EU AI Act Art. 50) is appended after it.
    assert.ok(done.answer?.startsWith(answer), `unexpected answer: ${String(done.answer)}`);

    // The canonical id is the cluster the dispatcher's `channelIdentity` resolves to.
    const { omadiaUserId } = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'api',
      channelUserId: keyId,
    });
    assert.ok(omadiaUserId);

    // ── Graph readback — the acceptance criterion ──────────────────────────
    const run = await waitForRun(sessionId);
    assert.ok(run, 'no Run node persisted for the API-key turn');
    assert.equal(run.user_id, omadiaUserId, 'Run is not filed under the canonical user id');
    assert.notEqual(run.user_id, keyId, 'Run carries the raw key id');
    assert.equal(run.properties['status'], 'success');

    const turn = await pool!.query<{ id: string; user_id: string | null }>(
      `SELECT t.id, t.user_id FROM graph_edges e
         JOIN graph_nodes t ON t.id = e.from_node AND t.type = 'Turn'
        WHERE e.tenant_id = $1 AND e.type = 'EXECUTED' AND e.to_node = $2`,
      [TENANT, run.id],
    );
    assert.equal(turn.rows.length, 1, 'Run has no EXECUTED edge from its Turn');

    const belongs = await pool!.query<{ cluster: string }>(
      `SELECT u.external_id AS cluster FROM graph_edges e
         JOIN graph_nodes u ON u.id = e.to_node AND u.type = 'User'
        WHERE e.tenant_id = $1 AND e.type = 'BELONGS_TO' AND e.from_node = $2`,
      [TENANT, turn.rows[0]!.id],
    );
    assert.deepEqual(
      belongs.rows.map((r) => r.cluster),
      [`user:${omadiaUserId}`],
      'Turn is not linked to the canonical User-Cluster',
    );

    const toolCalls = await pool!.query<{ tool: string; user_id: string | null }>(
      `SELECT tc.properties->>'toolName' AS tool, tc.user_id FROM graph_edges e
         JOIN graph_nodes tc ON tc.id = e.to_node AND tc.type = 'ToolCall'
        WHERE e.tenant_id = $1 AND e.type = 'INVOKED_TOOL' AND e.from_node = $2`,
      [TENANT, run.id],
    );
    assert.deepEqual(
      toolCalls.rows.map((r) => r.tool),
      ['query_knowledge_graph'],
      'the query_knowledge_graph call is not on the persisted Run',
    );
    t.diagnostic(
      `readback: Run ${run.external_id} user_id=${String(run.user_id)} status=${String(run.properties['status'])}; ` +
        `Turn -BELONGS_TO-> ${belongs.rows.map((r) => r.cluster).join(',')}; ` +
        `Run -INVOKED_TOOL-> ${toolCalls.rows.map((r) => r.tool).join(',')}; caller ${keyId}`,
    );
  });
});
