/**
 * #2060 — what a facilitator's RUNTIME does not have (spec 2043 §2.3).
 *
 * One test per omission, against the real factory (`buildForAgent`) and the
 * real native-tool registry shared by every agent, exactly as in production.
 * The write-time refusals live in `facilitatorOmissionsRoutes.test.ts`; these
 * are the second line: whatever reached the database, a built facilitator
 * still cannot do it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';
import type { ChatAgent, ChatStreamEvent, ChatTurnInput } from '@omadia/channel-sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import {
  facilitatorRefusalText,
  runAsEngineTurn,
  wrapFacilitatorAgent,
} from '../packages/harness-orchestrator/src/facilitatorAgent.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  assertNotFacilitator,
  FacilitatorOmissionError,
} from '../packages/harness-orchestrator/src/registry/agentKind.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import type {
  AgentPluginRow,
  AgentRow,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';
import { createPeerGate } from '../src/conductor/peerPolicy.js';
import { RealStepEffects } from '../src/conductor/realStepEffects.js';

const ENGINE = '@omadia/agent-facilitator';
const ODOO = '@omadia/integration-odoo';
const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };

function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: '00000000-0000-0000-0000-0000000000f1',
    slug: 'mara',
    name: 'Mara',
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    kind: 'facilitator',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function setup(): { registry: NativeToolRegistry; calls: string[]; deps: OrchestratorDeps; fastPathAsked: { value: number } } {
  const registry = new NativeToolRegistry();
  const calls: string[] = [];
  const tool = (name: string, agentId: string | undefined): void => {
    registry.register(name, {
      spec: { name, description: name, input_schema: { type: 'object', properties: {} } },
      handler: async () => {
        calls.push(name);
        return 'ok';
      },
      ...(agentId !== undefined ? { agentId } : {}),
      domain: 'test',
    } as never);
  };
  tool('facilitation_start', ENGINE);
  tool('odoo_version', ODOO);
  tool('unowned_kernel_tool', undefined);
  registry.registerHandler('memory', {
    handler: async () => {
      calls.push('memory');
      return 'root store';
    },
    agentId: '@omadia/memory',
  } as never);
  const fastPathAsked = { value: 0 };
  const deps = {
    client: new Anthropic({ apiKey: 'test-key' }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: registry,
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    assistantIdentity: 'You are the platform assistant.',
    contextRetriever: {},
    sessionBriefing: {},
    factExtractor: {},
    excerptExtractor: {},
    processMemory: {},
    autoPromote: true,
    microsoft365: { obo: {}, calendar: {}, slots: {} },
    fastPath: () => {
      fastPathAsked.value += 1;
      return undefined;
    },
  } as unknown as OrchestratorDeps;
  return { registry, calls, deps, fastPathAsked };
}

interface Probe {
  dispatchTool(n: string, i: unknown, o?: unknown, m?: unknown): Promise<string>;
  offeredToolNames(): ReadonlySet<string>;
  isToolGranted(name: string, pluginId: string | undefined): boolean;
  bindCliTurnMemory(input: ChatTurnInput): Promise<unknown>;
}
const probe = (built: ReturnType<typeof buildForAgent>): Probe => built.orchestrator as unknown as Probe;
const field = (built: ReturnType<typeof buildForAgent>, name: string): unknown =>
  (built.orchestrator as unknown as Record<string, unknown>)[name];

const PERSONA_SKILL = [{ skillId: 's1', slug: 'mara-coach', name: 'Coach', description: '', body: 'Be a coach.' }];

describe('facilitator runtime omissions', () => {
  it('memory tool: not offered, not granted, not dispatched', async () => {
    const { deps, calls } = setup();
    const fac = buildForAgent(row(), deps, RUNTIME, undefined, [ENGINE]);
    const std = buildForAgent(row({ slug: 'hr', kind: 'standard' }), deps, RUNTIME, undefined, []);
    assert.equal(probe(fac).isToolGranted('memory', '@omadia/memory'), false);
    assert.equal(probe(std).isToolGranted('memory', '@omadia/memory'), true, 'unchanged for a standard agent');
    assert.equal(probe(fac).offeredToolNames().has('memory'), false);
    const result = await probe(fac).dispatchTool('memory', { command: 'view', path: '/memories' });
    assert.match(result, /not available to this agent/);
    assert.deepEqual(calls, [], "the provider's root-store handler must never run");
    assert.equal(field(fac, 'memoryToolHandler'), undefined);
    assert.equal(field(fac, 'memoryBinder'), undefined);
    assert.equal(await probe(fac).bindCliTurnMemory({ userMessage: 'x' }), undefined);
    assert.notEqual(field(std, 'memoryToolHandler'), undefined);
  });

  it('recall, capture and learning jobs are not wired', () => {
    const { deps } = setup();
    const fac = buildForAgent(row(), deps, RUNTIME, undefined, [ENGINE]);
    const std = buildForAgent(row({ slug: 'hr', kind: 'standard' }), deps, RUNTIME, undefined, []);
    for (const name of [
      'contextRetriever', // recall
      'sessionBriefing', // recall
      'sessionLogger', // capture (transcripts + graph ingest)
      'knowledgeGraph', // capture target and graph tools
      'knowledgeGraphTool',
      'factExtractor', // learning
      'excerptExtractor', // learning
      'nudgeProcessMemory', // learning
    ]) {
      assert.equal(field(fac, name), undefined, `${name} must not be wired for a facilitator`);
      assert.notEqual(field(std, name), undefined, `${name} stays wired for a standard agent`);
    }
    assert.equal(field(fac, 'autoPromote'), false);
    assert.equal(field(std, 'autoPromote'), true);
  });

  it('acting for a user: no calendar tools on delegated tokens', () => {
    const { deps } = setup();
    const fac = buildForAgent(row(), deps, RUNTIME, undefined, [ENGINE]);
    assert.equal(field(fac, 'findFreeSlotsTool'), undefined);
    assert.equal(field(fac, 'bookMeetingTool'), undefined);
  });

  it('persona skills are dropped at build', () => {
    const { deps } = setup();
    const fac = buildForAgent(row(), deps, RUNTIME, PERSONA_SKILL, [ENGINE]);
    const std = buildForAgent(row({ slug: 'hr', kind: 'standard' }), deps, RUNTIME, PERSONA_SKILL, []);
    assert.deepEqual(field(fac, 'personaSkills'), []);
    assert.equal((field(std, 'personaSkills') as unknown[]).length, 1);
  });

  it('fast path: never consulted; a private request gets the refusal without a model call', async () => {
    const { deps, fastPathAsked } = setup();
    const fac = buildForAgent(row({ identityName: 'Mara' }), deps, RUNTIME, undefined, [ENGINE]);
    const answer = await fac.bundle.agent.chat({ userMessage: 'What was our revenue in May?' });
    assert.equal(answer.text, facilitatorRefusalText({ name: 'Mara' }));
    assert.equal(fastPathAsked.value, 0, 'the fast path was never asked');
  });

  it('plugin grants: only the engine plugin tools are offered and run', async () => {
    const { deps, calls } = setup();
    const fac = buildForAgent(row(), deps, RUNTIME, undefined, [ENGINE]);
    const offered = probe(fac).offeredToolNames();
    assert.equal(offered.has('facilitation_start'), true);
    assert.equal(offered.has('odoo_version'), false);
    assert.equal(offered.has('unowned_kernel_tool'), false, 'a tool without an owner is not the engine');
    assert.match(await probe(fac).dispatchTool('odoo_version', {}), /not available to this agent/);
    assert.match(await probe(fac).dispatchTool('unowned_kernel_tool', {}), /not available to this agent/);
    assert.equal(await probe(fac).dispatchTool('facilitation_start', {}), 'ok');
    assert.deepEqual(calls, ['facilitation_start']);
  });

  it('plugin grants: a facilitator built without a grant set gets nothing (fail closed)', () => {
    const { deps } = setup();
    const fac = buildForAgent(row(), deps, RUNTIME);
    assert.equal(probe(fac).offeredToolNames().has('facilitation_start'), false);
    const std = buildForAgent(row({ slug: 'legacy', kind: 'standard' }), deps, RUNTIME);
    assert.equal(probe(std).offeredToolNames().has('odoo_version'), true, 'legacy ungated path unchanged');
  });

  it('plugin grants: the registry drops rows that are not the engine', () => {
    const { deps } = setup();
    const make = (grantable: readonly string[] | undefined): OrchestratorRegistry =>
      new OrchestratorRegistry({} as never, deps, {
        defaultRuntimeConfig: RUNTIME,
        ...(grantable !== undefined
          ? { pluginLookup: { isMultiInstance: () => true, facilitatorGrantable: () => grantable } }
          : {}),
      } as never);
    const rows = [
      { agentId: 'a', pluginId: ENGINE, config: {}, enabled: true, createdAt: new Date(0) },
      { agentId: 'a', pluginId: ODOO, config: {}, enabled: true, createdAt: new Date(0) },
    ] satisfies AgentPluginRow[];
    const grantsFor = (reg: OrchestratorRegistry, agent: AgentRow): string[] =>
      (reg as unknown as { grantedPluginIdsFor(a: AgentRow, p: AgentPluginRow[]): string[] }).grantedPluginIdsFor(agent, rows);
    assert.deepEqual(grantsFor(make([ENGINE]), row()), [ENGINE]);
    assert.deepEqual(grantsFor(make([]), row()), [], 'no engine installed');
    assert.deepEqual(grantsFor(make(undefined), row()), [], 'no lookup wired');
    // The other direction: the engine's tools are for facilitators only.
    assert.deepEqual(grantsFor(make([ENGINE]), row({ kind: 'standard' })), [ODOO]);
    assert.deepEqual(grantsFor(make(undefined), row({ kind: 'standard' })), [ENGINE, ODOO], 'no lookup: unchanged');
  });
});

describe('facilitator assistance refusal', () => {
  function inner(): { agent: ChatAgent; turns: ChatTurnInput[] } {
    const turns: ChatTurnInput[] = [];
    const agent: ChatAgent = {
      chat: (input) => {
        turns.push(input);
        return Promise.resolve({ text: 'model answer' } as never);
      },
      async *chatStream(input): AsyncGenerator<ChatStreamEvent> {
        turns.push(input);
        yield { type: 'done', answer: 'model answer', toolCalls: 0, iterations: 0 } as ChatStreamEvent;
      },
    };
    return { agent, turns };
  }
  const personal: ChatTurnInput = {
    userMessage: 'Can you summarise this document for me?',
    origin: { channelType: 'teams', scope: { kind: 'personal', userId: 'u1' } },
  };
  const group: ChatTurnInput = {
    userMessage: 'Mara, please run a vote on the offsite date.',
    origin: { channelType: 'teams', scope: { kind: 'conversation', conversationId: '19:abc@thread.v2' } },
  };

  it('a 1:1 request for help gets the friendly refusal, in chat and stream', async () => {
    const { agent, turns } = inner();
    const wrapped = wrapFacilitatorAgent(agent, { name: 'Mara', locale: 'de' });
    const refusal = facilitatorRefusalText({ name: 'Mara', locale: 'de' });
    assert.equal((await wrapped.chat(personal)).text, refusal);
    const events: ChatStreamEvent[] = [];
    for await (const e of wrapped.chatStream(personal)) events.push(e);
    assert.deepEqual(events.map((e) => e.type), ['text_delta', 'done']);
    assert.equal((events[1] as { answer: string }).answer, refusal);
    assert.match(refusal, /Moderator und kein Assistent/);
    assert.equal(turns.length, 0, 'the model was never reached');
  });

  it('refuses a turn nobody placed in a group (web chat, API, workflow step)', async () => {
    const { agent, turns } = inner();
    const wrapped = wrapFacilitatorAgent(agent, {});
    for (const input of [
      { userMessage: 'hi' },
      { userMessage: 'hi', origin: { channelType: 'http', scope: { kind: 'unscoped', reason: 'absent' } } },
      { userMessage: 'hi', origin: { channelType: 'conductor', scope: { kind: 'system', origin: 'conductor', id: 'r1' } } },
    ] as ChatTurnInput[]) {
      assert.match((await wrapped.chat(input)).text, /I am a facilitator, not an assistant/);
    }
    assert.equal(turns.length, 0);
  });

  it('a group turn and an engine-run turn reach the model', async () => {
    const { agent, turns } = inner();
    const wrapped = wrapFacilitatorAgent(agent, {});
    assert.equal((await wrapped.chat(group)).text, 'model answer');
    const viaEngine = await runAsEngineTurn({ pluginId: ENGINE }, () => wrapped.chat(personal));
    assert.equal(viaEngine.text, 'model answer');
    assert.equal(turns.length, 2);
  });
});

describe('facilitator: no kernel turn where the engine drives the conversation', () => {
  it('suppresses a channel turn (even a mention) once the engine holds the subscription', async () => {
    const turns: ChatTurnInput[] = [];
    const agent: ChatAgent = {
      chat: (input) => {
        turns.push(input);
        return Promise.resolve({ text: 'model answer' } as never);
      },
      async *chatStream(input): AsyncGenerator<ChatStreamEvent> {
        turns.push(input);
        yield { type: 'done', answer: 'model answer', toolCalls: 0, iterations: 0 } as ChatStreamEvent;
      },
    };
    const asked: string[] = [];
    const wrapped = wrapFacilitatorAgent(agent, {
      agentSlug: 'mara',
      isEngineDriven: (slug, channelType, conversationId) => {
        asked.push(`${slug}|${channelType}|${conversationId}`);
        return conversationId === '19:offsite@thread.v2';
      },
    });
    // Teams folds its prefix into the session scope; the subscription is
    // keyed by the channel-native id.
    const mention = (conversationId: string): ChatTurnInput => ({
      userMessage: '@Mara my vote: A > C > B',
      origin: { channelType: 'teams', scope: { kind: 'conversation', conversationId } },
    });
    for (const id of ['19:offsite@thread.v2', 'teams-19:offsite@thread.v2', '@omadia/channel-teams::19:offsite@thread.v2']) {
      assert.equal((await wrapped.chat(mention(id))).text, '', `no second answer for ${id}`);
    }
    const events: ChatStreamEvent[] = [];
    for await (const e of wrapped.chatStream(mention('teams-19:offsite@thread.v2'))) events.push(e);
    assert.deepEqual(events.map((e) => e.type), ['done'], 'no text delta at all');
    assert.equal(turns.length, 0);

    // First contact in another chat still reaches the model…
    assert.equal((await wrapped.chat(mention('teams-19:other@thread.v2'))).text, 'model answer');
    // …and the engine's own turn in the driven chat does too.
    const engineTurn = await runAsEngineTurn({ pluginId: ENGINE }, () =>
      wrapped.chat(mention('19:offsite@thread.v2')),
    );
    assert.equal(engineTurn.text, 'model answer');
    assert.equal(turns.length, 2);
    assert.ok(asked.includes('mara|teams|19:offsite@thread.v2'));
  });

  it('a lookup that throws suppresses nothing', async () => {
    const wrapped = wrapFacilitatorAgent(
      { chat: () => Promise.resolve({ text: 'model answer' } as never), chatStream: (() => undefined) as never },
      {
        agentSlug: 'mara',
        isEngineDriven: () => {
          throw new Error('registry gone');
        },
      },
    );
    const answer = await wrapped.chat({
      userMessage: 'hi',
      origin: { channelType: 'teams', scope: { kind: 'conversation', conversationId: 'c' } },
    });
    assert.equal(answer.text, 'model answer');
  });
});

describe('facilitator and other agents', () => {
  const registryWith = (agent: AgentRow): never =>
    ({
      get: (slug: string) =>
        slug === agent.slug
          ? { agent, built: { bundle: { agent: { chat: () => Promise.reject(new Error('must not run')) } } } }
          : undefined,
      identityForChannel: () => undefined,
    }) as never;

  it('agent-to-agent: the peer gate is closed in both directions, whatever the switches say', async () => {
    const policies = (agentId: string) => () =>
      Promise.resolve([{ channelType: 'teams', channelKey: 'c1', agentId, agentToAgent: true, createdAt: new Date(0), updatedAt: new Date(0) }]);
    const fac = row({ agentToAgent: 'on' });
    const std = row({ slug: 'hr', kind: 'standard', agentToAgent: 'on', id: '00000000-0000-0000-0000-0000000000a1' });
    const gateFor = (agent: AgentRow) =>
      createPeerGate({ getRegistry: () => registryWith(agent), listChannelPeerPolicies: policies(agent.id) });
    assert.equal(await gateFor(fac)('teams', 'c1', 'mara'), false);
    assert.equal(await gateFor(std)('teams', 'c1', 'hr'), true, 'unchanged for a standard agent');
  });

  it('consultation: a workflow step cannot run a facilitator', async () => {
    const effects = new RealStepEffects({ getRegistry: () => registryWith(row()) });
    await assert.rejects(
      effects.runAgentStep(
        { id: 's1', type: 'agent', agentId: 'mara', prompt: 'Summarise.' } as never,
        {},
        { runId: 'r1', workflowId: 'w1', trigger: { kind: 'manual' } } as never,
      ),
      // Matched structurally: the conductor resolves the class through the
      // built package, this file through its source.
      (err: unknown) =>
        (err as { code?: string }).code === 'facilitator_omission' &&
        (err as { omission?: string }).omission === 'consultation',
    );
  });

  it('assertNotFacilitator is the shared seam', () => {
    assert.throws(
      () => assertNotFacilitator(row(), 'consultation'),
      (err: unknown) =>
        err instanceof FacilitatorOmissionError &&
        err.code === 'facilitator_omission' &&
        err.agentSlug === 'mara' &&
        /neither consults other agents nor is consulted/.test(err.message),
    );
    assert.doesNotThrow(() => assertNotFacilitator(row({ kind: 'standard' }), 'consultation'));
    assert.doesNotThrow(() => assertNotFacilitator(undefined, 'consultation'));
  });
});
