/**
 * Spec 2042 §6 criteria 8 and 14 — no model call before (or instead of) the
 * agent, measured at the model gateway.
 *
 * Every provider calls `admitModelCall()` before it reaches its backend
 * (`@omadia/llm-provider-api`), so the gate slot sees every model call of the
 * process, inbound processing and helpers included. These tests put a
 * recording check into that slot, in front of the real gate in `enforce`
 * mode, and route turns through the real management layer
 * (`ChannelResolver` → `ManagementRouter` over a `SnapshotRoutingView`) and,
 * for the web, the real chat router:
 *
 *  - criterion 14: (U, Teams) → M, (Teams) → N, instance `off`. U's
 *    unaddressed Teams message reaches M, another user's reaches N, both in
 *    their own agent-turn context; an unaddressed web message gets the
 *    `system` notice and the gate sees no call at all (JSON and stream).
 *  - criterion 8: the unaddressed `no_agent` turn's usage is empty; in an
 *    addressed turn of a built agent (`buildForAgent`) the fast path's
 *    planning, the model routing classifier and the agent loop all run in
 *    the addressed agent's execution context.
 */

import { strict as assert } from 'node:assert';
import { after, afterEach, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import {
  admitModelCall,
  MODEL_CALL_GATE_SLOT,
  type LlmProvider,
  type LlmResponse,
  type LlmStreamEvent,
  type ModelOperation,
} from '@omadia/llm-provider';
import { InMemoryMemoryStore } from '@omadia/memory';
import { EntityRefBus, InMemoryNudgeRegistry } from '@omadia/plugin-api';
import {
  ChannelResolver,
  speakerFor,
  withAgentTurnExecution,
  type ChatAgent,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';
import {
  currentExecutionContext,
  installModelCallGate,
  modelGatewayMode,
  setModelGatewayMode,
  type ModelExecutionContext,
} from '@omadia/usage-telemetry';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { FastPathTriagePort } from '../packages/harness-orchestrator/src/fastPathAgent.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import { SnapshotRoutingView } from '../packages/harness-orchestrator/src/registry/routingView.js';
import type { AgentRow, ConfigSnapshot } from '../packages/harness-orchestrator/src/registry/configStore.js';
import type { DefaultAgentEntryRow } from '../packages/harness-orchestrator/src/registry/routingTables.js';
import { createChatRouter, type WebRouteRequest, type WebRouteResult } from '../src/routes/chat.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

const NOW = new Date('2026-11-20T00:00:00Z');
const U = 'ursula@example.com';
const OTHER = 'otto@example.com';

function agentRow(slug: string): AgentRow {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    identityName: slug.toUpperCase(),
    availableToEveryone: true,
    availableChannels: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function entry(principal: string | null, channelType: string | null, agentId: string | null): DefaultAgentEntryRow {
  return { id: `e-${principal ?? '*'}-${channelType ?? '*'}`, principal, channelType, agentId, updatedBy: null, updatedAt: NOW };
}

interface RecordedCall {
  readonly operation: ModelOperation;
  readonly context: ModelExecutionContext | undefined;
}

/** Records every model call the gate sees, then lets the real gate decide. */
function recordModelCalls(): { calls: RecordedCall[]; restore(): void } {
  installModelCallGate();
  const slots = globalThis as unknown as Record<symbol, ((op: ModelOperation) => void) | undefined>;
  const real = slots[MODEL_CALL_GATE_SLOT];
  const previousMode = modelGatewayMode();
  setModelGatewayMode('enforce');
  const calls: RecordedCall[] = [];
  slots[MODEL_CALL_GATE_SLOT] = (operation) => {
    calls.push({ operation, context: currentExecutionContext() });
    real?.(operation);
  };
  return {
    calls,
    restore: () => {
      slots[MODEL_CALL_GATE_SLOT] = real;
      setModelGatewayMode(previousMode);
    },
  };
}

/** An agent runtime whose turn makes one model call, as a provider would. */
function modelBackedAgent(slug: string): ChatAgent {
  return {
    chat: () => {
      admitModelCall('complete');
      return Promise.resolve({ text: `answer from ${slug}` });
    },
    async *chatStream() {
      admitModelCall('complete');
      yield { type: 'done', answer: `answer from ${slug}`, toolCalls: 0, iterations: 1 };
    },
  } as unknown as ChatAgent;
}

/** (U, Teams) → M, (Teams) → N, instance off. */
function registry(): OrchestratorRegistry {
  const rows = [agentRow('m'), agentRow('n')];
  const snapshot: ConfigSnapshot = {
    agents: rows,
    agentPlugins: [],
    channelBindings: [],
    defaultEntries: [entry(`user:${U}`, 'teams', 'id-m'), entry(null, 'teams', 'id-n'), entry(null, null, null)],
  };
  const view = new SnapshotRoutingView(snapshot);
  // What the registry builds: the agent's runtime inside its agent-turn context.
  const active = new Map(
    rows.map((row) => [
      row.id,
      { agent: row, built: { bundle: { agent: withAgentTurnExecution(modelBackedAgent(row.slug), row.slug) } } },
    ]),
  );
  return {
    routingView: () => view,
    getById: (id: string) => active.get(id),
    size: () => active.size,
  } as unknown as OrchestratorRegistry;
}

async function drain(agent: ChatAgent): Promise<Record<string, unknown> | undefined> {
  let done: Record<string, unknown> | undefined;
  for await (const event of agent.chatStream({ userMessage: 'Wie ist der Stand?', sessionScope: 'teams::conv' })) {
    if (event.type === 'done') done = event as unknown as Record<string, unknown>;
  }
  return done;
}

describe('criteria 8 and 14 — no model call before or instead of the agent', () => {
  let recorder: ReturnType<typeof recordModelCalls>;
  let server: Server;
  let base: string;
  const reg = registry();
  const resolver = new ChannelResolver({ registry: reg });

  // The kernel's web routing (src/index.ts `routeWebTurn`) over the resolver.
  const routeWebTurn = (request: WebRouteRequest): WebRouteResult => {
    const result = resolver.resolve('web', request.conversationKey, {
      ...(request.principal ? { principal: request.principal } : {}),
      ...(request.explicitSlug ? { explicitSlug: request.explicitSlug } : {}),
      locale: 'en',
    });
    if (result.decision === 'bound' && result.agent && result.chatAgent) {
      return { kind: 'agent', chatAgent: result.chatAgent, slug: result.agent.agent.slug, speaker: speakerFor(result.agent.agent) };
    }
    assert.ok(result.notice, 'a refusal always carries its notice');
    return { kind: 'notice', notice: result.notice };
  };

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: { email: string } }).session = { email: U };
      next();
    });
    app.use('/api', createChatRouter({ routeTurn: routeWebTurn, hasActiveAgents: () => true }));
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/chat`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    recorder.restore();
  });

  const post = (url: string, body: Record<string, unknown>): Promise<Response> =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it("criterion 14: U's unaddressed Teams message goes to M, another user's to N, each call in its agent's envelope", async () => {
    recorder = recordModelCalls();
    const forU = resolver.resolve('teams', '19:conv', { principal: `user:${U}` });
    assert.equal(forU.decision, 'bound');
    assert.equal((await drain(forU.chatAgent!))?.['answer'], 'answer from m');
    const forOther = resolver.resolve('teams', '19:conv', { principal: `user:${OTHER}` });
    assert.equal((await drain(forOther.chatAgent!))?.['answer'], 'answer from n');
    assert.deepEqual(
      recorder.calls.map((c) => c.context),
      [
        { kind: 'agent_turn', ownerId: 'm', agentSlug: 'm' },
        { kind: 'agent_turn', ownerId: 'n', agentSlug: 'n' },
      ],
    );
  });

  it('criterion 14: an unaddressed web message gets the system notice and no model call (JSON and stream)', async () => {
    recorder = recordModelCalls();
    const res = await post(base, { message: 'hallo' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { speaker: unknown; systemNotice: { code: string } };
    assert.deepEqual(body.speaker, { kind: 'system' });
    assert.equal(body.systemNotice.code, 'no_agent');

    const streamed = await post(`${base}/stream`, { message: 'hallo' });
    const events = (await streamed.text()).split('\n').filter((l) => l.trim() !== '');
    assert.equal(events.length, 1, 'one done event, nothing else');
    const done = JSON.parse(events[0]!) as { speaker: unknown; systemNotice: { code: string } };
    assert.deepEqual(done.speaker, { kind: 'system' });
    assert.equal(done.systemNotice.code, 'no_agent');

    assert.deepEqual(recorder.calls, [], 'the gate saw a model call for a turn no agent answers');
  });

  it("criterion 8: the no_agent turn's usage is empty, while an addressed web turn's only call is the agent's own", async () => {
    recorder = recordModelCalls();
    const unaddressed = await post(base, { message: 'hallo' });
    assert.equal(((await unaddressed.json()) as { systemNotice: { code: string } }).systemNotice.code, 'no_agent');
    assert.equal(recorder.calls.length, 0);

    // Positive control: the same router and gate do see a call when an agent answers.
    const addressed = await post(base, { message: 'hallo', agentSlug: 'n' });
    assert.equal(addressed.status, 200);
    const body = (await addressed.json()) as { speaker: { kind: string; slug?: string } };
    assert.equal(body.speaker.slug, 'n');
    assert.deepEqual(
      recorder.calls.map((c) => c.context),
      [{ kind: 'agent_turn', ownerId: 'n', agentSlug: 'n' }],
    );
  });
});

// ── an addressed turn: fast-path planning, routing and the agent loop ──────

function scriptedProvider(): LlmProvider {
  const final = (text: string): LlmResponse =>
    ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }) as unknown as LlmResponse;
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: false,
      streaming: true,
      promptCaching: false,
      forcedToolChoice: false,
      parallelToolCalls: false,
    },
    // The routing classifier (Haiku tier).
    complete: () => {
      admitModelCall('complete');
      return Promise.resolve(final('SIMPLE'));
    },
    // The agent's own loop.
    stream: () => {
      admitModelCall('complete');
      const events = [
        { type: 'text_delta', text: 'Der Stand ist gut.' },
        { type: 'final', response: final('Der Stand ist gut.') },
      ] as unknown as LlmStreamEvent[];
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function builtAgentDeps(fastPath: FastPathTriagePort): OrchestratorDeps {
  const names = new Set<string>();
  return {
    provider: scriptedProvider(),
    knowledgeGraph: new InMemoryKnowledgeGraph(),
    memoryStore: new InMemoryMemoryStore(),
    entityRefBus: new EntityRefBus(),
    nativeToolRegistry: {
      get: () => undefined,
      listWithHandler: () => [],
      has: (n: string) => names.has(n),
      register: (n: string) => {
        names.add(n);
        return () => names.delete(n);
      },
    },
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    fastPath: () => fastPath,
  } as unknown as OrchestratorDeps;
}

describe('criterion 8 — every model call of an addressed turn runs in the addressed agent', () => {
  it('criterion 8: fast-path planning, model routing and the agent loop all run in the addressed agent envelope', async () => {
    const recorder = recordModelCalls();
    try {
      const triaged: Array<ModelExecutionContext | undefined> = [];
      // The fast lane's planning call (its model sits behind the same gate);
      // it hands the turn to the agent without a route, so routing classifies.
      const fastPath: FastPathTriagePort = {
        channelEnabled: () => true,
        triageChatTurn: () => {
          triaged.push(currentExecutionContext());
          admitModelCall('complete');
          return Promise.resolve({ kind: 'agent', reason: 'needs the agent', ms: 1 });
        },
      };
      const row: AgentRow = { ...agentRow('strategist'), id: '00000000-0000-0000-0000-0000000000aa' };
      const built = buildForAgent(row, builtAgentDeps(fastPath), {
        model: 'opus',
        maxTokens: 100,
        maxToolIterations: 2,
        modelRouting: { classifierModel: 'haiku', simpleModel: 'sonnet', complexModel: 'opus' },
      });

      const done = await drain(built.bundle.agent);
      assert.ok(String(done?.['answer'] ?? '').startsWith('Der Stand ist gut.'), JSON.stringify(done));

      const strategist = { kind: 'agent_turn', ownerId: 'strategist', agentSlug: 'strategist' };
      assert.deepEqual(triaged, [strategist], 'the fast path planned outside the agent');
      assert.equal(recorder.calls.length, 3, 'planning + routing + loop');
      for (const call of recorder.calls) assert.deepEqual(call.context, strategist);
    } finally {
      recorder.restore();
    }
  });
});
