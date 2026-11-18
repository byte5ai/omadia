/**
 * 'agentTurn@1' and the tool call context (#2043).
 *
 * The facilitation engine asks the kernel to run one turn as a facilitator
 * and gets the text back unposted; tools called in that turn are told, by the
 * kernel, which agent, conversation, stored event and caller they serve.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';
import type { ChatAgent, ChatTurnInput } from '@omadia/channel-sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
  NativeToolCallContext,
} from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import { CliChatAgent } from '../packages/harness-orchestrator/src/cliChatAgent.js';
import {
  currentEngineTurn,
  runAsEngineTurn,
  wrapFacilitatorAgent,
} from '../packages/harness-orchestrator/src/facilitatorAgent.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import {
  buildToolCallContext,
  currentToolCallContext,
  runWithToolCallContext,
} from '../packages/harness-orchestrator/src/toolCallContext.js';
import { ToolDispatchService } from '../packages/harness-orchestrator/src/toolDispatchService.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import {
  AgentTurnBudget,
  AgentTurnHistory,
  createAgentTurnService,
} from '../src/agents/agentTurnService.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import {
  CONVERSATION,
  ENGINE,
  hubFixture,
  messageEvent,
  scopeOf,
} from './_helpers/conversationMessagesFixture.js';

const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };

function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: '00000000-0000-0000-0000-0000000000f1',
    slug: 'mara',
    name: 'mara',
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    kind: 'facilitator',
    identityName: 'Mara',
    identityShortDescription: 'Moderates decisions.',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe('NativeToolCallContext', () => {
  function setup(): { deps: OrchestratorDeps; registry: NativeToolRegistry; seen: (NativeToolCallContext | undefined)[] } {
    const registry = new NativeToolRegistry();
    const seen: (NativeToolCallContext | undefined)[] = [];
    registry.register('facilitation_status', {
      spec: { name: 'facilitation_status', description: 's', input_schema: { type: 'object', properties: {} } },
      handler: async (_input: unknown, context?: NativeToolCallContext) => {
        seen.push(context);
        return 'ok';
      },
      agentId: ENGINE,
      domain: 'facilitation',
    } as never);
    const deps = {
      client: new Anthropic({ apiKey: 'test-key' }),
      knowledgeGraph: {} as KnowledgeGraph,
      memoryStore: {} as MemoryStore,
      entityRefBus: {} as EntityRefBus,
      nativeToolRegistry: registry,
      nudgeRegistry: new InMemoryNudgeRegistry(),
      responseGuard: () => undefined,
      privacyGuard: () => undefined,
    } as unknown as OrchestratorDeps;
    return { deps, registry, seen };
  }

  const groupTurn: ChatTurnInput = {
    userMessage: '@Mara please run a vote',
    userId: 'AAD-Anna',
    channelIdentity: { channelKind: 'teams' as never, channelUserId: 'AAD-Anna' },
    origin: {
      channelType: 'teams',
      scope: { kind: 'conversation', conversationId: `teams-${CONVERSATION}` },
    },
  };

  it('is built from the turn: agent, channel, channel-native conversation, caller', () => {
    assert.deepEqual(buildToolCallContext('mara', groupTurn), {
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: CONVERSATION,
      callerPrincipalId: 'user:aad-anna',
      callerUserRef: { kind: 'teams', id: 'AAD-Anna' },
    });
    const viaCoreApi = buildToolCallContext('mara', {
      userMessage: 'x',
      origin: { channelType: 'slack', scope: { kind: 'conversation', conversationId: '@acme/slack::C123' } },
    });
    assert.deepEqual(viaCoreApi, { agentSlug: 'mara', channelType: 'slack', conversationId: 'C123' });
    // A personal chat names no conversation; nothing is guessed.
    assert.deepEqual(
      buildToolCallContext('mara', {
        userMessage: 'x',
        origin: { channelType: 'teams', scope: { kind: 'personal', userId: 'u1' }, principal: { kind: 'user', userId: 'u1' } },
      }),
      { agentSlug: 'mara', channelType: 'teams', callerPrincipalId: 'user:u1' },
    );
    assert.deepEqual(buildToolCallContext('mara', { userMessage: 'x' }), { agentSlug: 'mara' });
  });

  it('an engine-run turn states conversation, inbound event and caller itself', () => {
    const context = runAsEngineTurn(
      {
        pluginId: ENGINE,
        toolContext: {
          channelType: 'teams',
          conversationId: CONVERSATION,
          inboundEventId: '42',
          callerPrincipalId: 'user:aad-ben',
          callerUserRef: { kind: 'teams-aad', id: 'AAD-Ben' },
        },
      },
      () => buildToolCallContext('mara', groupTurn),
    );
    assert.deepEqual(context, {
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: CONVERSATION,
      inboundEventId: '42',
      callerPrincipalId: 'user:aad-ben',
      callerUserRef: { kind: 'teams-aad', id: 'AAD-Ben' },
    });
  });

  it('reaches a plugin tool handler as the second argument (in-process loop)', async () => {
    const { deps, seen } = setup();
    const built = buildForAgent(row(), deps, RUNTIME, undefined, [ENGINE]);
    const orchestrator = built.orchestrator as unknown as {
      dispatchTool(n: string, i: unknown, o?: unknown, m?: unknown): Promise<string>;
    };
    const toolCall = buildToolCallContext('mara', groupTurn);
    await turnContext.run({ turnId: 't1', turnDate: '2026-11-18', toolCall }, () =>
      orchestrator.dispatchTool('facilitation_status', {}),
    );
    // Outside any turn the handler still learns which agent dispatched it.
    await orchestrator.dispatchTool('facilitation_status', {});
    assert.deepEqual(seen, [toolCall, { agentSlug: 'mara' }]);
  });

  it('reaches the handler on the subscription-CLI dispatch path too', async () => {
    const { registry, seen } = setup();
    const dispatch = new ToolDispatchService({ nativeTools: registry, agentSlug: 'mara' });
    const toolCall = buildToolCallContext('mara', groupTurn);
    await runWithToolCallContext(toolCall, () => dispatch.dispatch('facilitation_status', {}));
    await dispatch.dispatch('facilitation_status', {});
    assert.deepEqual(seen, [toolCall, { agentSlug: 'mara' }]);

    // The CLI runtime restores a snapshot before a loopback dispatch; the
    // context is bound inside it.
    const agent = new CliChatAgent({ dispatch } as never) as unknown as {
      captureTurnContext(input: ChatTurnInput): { runInTurnContext<T>(fn: () => T): T };
    };
    const captured = agent.captureTurnContext(groupTurn);
    assert.deepEqual(captured.runInTurnContext(() => currentToolCallContext()), toolCall);
    assert.equal(currentToolCallContext(), undefined);
  });
});

describe('agentTurn service', () => {
  interface Seen {
    input: ChatTurnInput;
    engine: ReturnType<typeof currentEngineTurn>;
    toolCall: NativeToolCallContext;
  }

  async function setup(options: { agent?: Partial<AgentRow>; granted?: boolean; isEngine?: boolean; perMinute?: number } = {}) {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    const stored = await f.hub.ingest(messageEvent({ text: 'My vote: A > C > B' }));
    assert.ok(stored);
    const seen: Seen[] = [];
    let nextAnswer: string | Error = 'Recorded for you: A > C > B.';
    const inner: ChatAgent = {
      chat: (input) => {
        seen.push({ input, engine: currentEngineTurn(), toolCall: buildToolCallContext('mara', input) });
        return typeof nextAnswer === 'string'
          ? Promise.resolve({ text: nextAnswer })
          : Promise.reject(nextAnswer);
      },
      chatStream: (() => undefined) as never,
    };
    const agent = row(options.agent);
    // The real refusal gate in front of the fake model: an engine turn must pass it.
    const bundleAgent = agent.kind === 'facilitator' ? wrapFacilitatorAgent(inner, { agentSlug: 'mara' }) : inner;
    const entry = {
      agent,
      plugins: options.granted === false ? [] : [{ pluginId: ENGINE, enabled: true }],
      built: { bundle: { agent: bundleAgent } },
    };
    const service = createAgentTurnService({
      getRegistry: () =>
        ({
          get: (slug: string) => (slug === 'mara' ? entry : undefined),
          channelTypesWithIdentity: () => ['teams'],
        }) as never,
      messages: f.hub,
      callerPluginId: ENGINE,
      isEngine: () => options.isEngine !== false,
      history: new AgentTurnHistory(),
      budget: new AgentTurnBudget(options.perMinute ?? 60),
      language: () => 'de',
    });
    const request = {
      agentSlug: 'mara',
      sessionKey: 'facilitation-7',
      channelType: 'teams',
      conversationId: CONVERSATION,
      inboundEventId: stored.eventId,
      input: 'Anna wrote: My vote: A > C > B',
      engineContext: 'Step: prioritise. Recorded: Anna A > C > B. Open: 2.',
    };
    return { service, request, seen, stored, setAnswer: (a: string | Error) => void (nextAnswer = a) };
  }

  it('runs one turn as the facilitator and returns the text', async () => {
    const { service, request, seen, stored } = await setup();
    assert.deepEqual(await service.runTurn(request), {
      outcome: 'completed',
      text: 'Recorded for you: A > C > B.',
    });
    assert.equal(seen.length, 1);
    const { input, engine, toolCall } = seen[0]!;
    assert.equal(input.userMessage, request.input);
    assert.equal(input.extraSystemHint, request.engineContext, 'engine state rides as the turn hint, after the identity');
    assert.equal(input.sessionScope, 'facilitation:mara:facilitation-7');
    assert.deepEqual(input.origin, {
      channelType: 'teams',
      scope: { kind: 'conversation', conversationId: CONVERSATION },
      principal: { kind: 'user', userId: 'aad-anna' },
    });
    assert.equal(input.userId, 'AAD-Anna', 'the caller is the platform-stated author of the stored event');
    assert.equal(engine?.pluginId, ENGINE);
    assert.deepEqual(toolCall, {
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: CONVERSATION,
      inboundEventId: stored.eventId,
      callerPrincipalId: 'user:aad-anna',
      callerUserRef: { kind: 'teams-aad', id: 'AAD-Anna' },
    });
  });

  it('turns with the same session key share history; another key starts empty', async () => {
    const { service, request, seen, setAnswer } = await setup();
    await service.runTurn(request);
    setAnswer('Two contributions are still open.');
    await service.runTurn({ ...request, inboundEventId: undefined, input: 'Timer: remind the group.' });
    await service.runTurn({ ...request, sessionKey: 'facilitation-8', inboundEventId: undefined });
    assert.deepEqual(seen[0]!.input.priorTurns, []);
    assert.deepEqual(seen[1]!.input.priorTurns, [
      { userMessage: request.input, assistantAnswer: 'Recorded for you: A > C > B.' },
    ]);
    assert.deepEqual(seen[2]!.input.priorTurns, []);
    // An engine-started turn has no caller.
    assert.equal(seen[1]!.input.userId, undefined);
    assert.equal(seen[1]!.toolCall.inboundEventId, undefined);
    assert.equal(seen[1]!.toolCall.callerPrincipalId, undefined);
  });

  it('refuses a caller that is not the engine, and an agent it is not bound to', async () => {
    const notEngine = await setup({ isEngine: false });
    const a = await notEngine.service.runTurn(notEngine.request);
    assert.deepEqual([a.outcome, a.outcome === 'refused' && a.code], ['refused', 'not_bound']);

    const standard = await setup({ agent: { kind: 'standard' } });
    const b = await standard.service.runTurn(standard.request);
    assert.equal(b.outcome === 'refused' && b.code, 'not_bound');
    assert.match(b.outcome === 'refused' ? b.message : '', /runs facilitators only/);

    const ungranted = await setup({ granted: false });
    const c = await ungranted.service.runTurn(ungranted.request);
    assert.equal(c.outcome === 'refused' && c.code, 'not_bound');

    const unknown = await setup();
    const d = await unknown.service.runTurn({ ...unknown.request, agentSlug: 'ghost' });
    assert.equal(d.outcome === 'refused' && d.code, 'unknown_agent');
    for (const s of [notEngine, standard, ungranted, unknown]) assert.equal(s.seen.length, 0);
  });

  it('refuses an inbound event that is not a stored message of this conversation', async () => {
    const { service, request, seen } = await setup();
    for (const bad of [
      { inboundEventId: '999999' },
      { conversationId: '19:other@thread.v2' },
    ]) {
      const outcome = await service.runTurn({ ...request, ...bad });
      assert.equal(outcome.outcome === 'refused' && outcome.code, 'unavailable');
    }
    const invalid = await service.runTurn({ ...request, input: '' });
    assert.equal(invalid.outcome === 'refused' && invalid.code, 'unavailable');
    assert.equal(seen.length, 0);
  });

  it('holds a turn budget per agent and minute', async () => {
    const { service, request, seen } = await setup({ perMinute: 2 });
    assert.equal((await service.runTurn(request)).outcome, 'completed');
    assert.equal((await service.runTurn(request)).outcome, 'completed');
    const third = await service.runTurn(request);
    assert.equal(third.outcome === 'refused' && third.code, 'budget_exceeded');
    assert.equal(seen.length, 2);
    let now = 0;
    const budget = new AgentTurnBudget(1, () => now);
    assert.equal(budget.tryTake('mara'), true);
    assert.equal(budget.tryTake('mara'), false);
    assert.equal(budget.tryTake('nora'), true, 'per agent');
    now = 60_001;
    assert.equal(budget.tryTake('mara'), true);
    assert.equal(new AgentTurnBudget(0).tryTake('mara'), true, '0 = no ceiling');
  });

  it('reports a failed turn instead of throwing, and keeps it out of the history', async () => {
    const { service, request, seen, setAnswer } = await setup();
    setAnswer(new Error('provider overloaded'));
    assert.deepEqual(await service.runTurn(request), { outcome: 'failed', message: 'provider overloaded' });
    setAnswer('ok');
    await service.runTurn(request);
    assert.deepEqual(seen[1]!.input.priorTurns, []);
  });

  it('getProfile answers for a bound facilitator only', async () => {
    const { service } = await setup({ agent: { identityLanguage: 'en-GB' } });
    assert.deepEqual(await service.getProfile!('mara'), {
      agentSlug: 'mara',
      kind: 'facilitator',
      displayName: 'Mara',
      shortDescription: 'Moderates decisions.',
      language: 'en-GB',
      ownIdentityChannelTypes: ['teams'],
    });
    const platform = await setup({ agent: { identityName: null } });
    const profile = await platform.service.getProfile!('mara');
    assert.equal(profile?.displayName, 'mara', 'falls back to the agent label');
    assert.equal(profile?.language, 'de', 'falls back to the installation language');
    assert.equal(await service.getProfile!('ghost'), undefined);
    assert.equal(await (await setup({ isEngine: false })).service.getProfile!('mara'), undefined);
    assert.equal(await (await setup({ agent: { kind: 'standard' } })).service.getProfile!('mara'), undefined);
  });
});
