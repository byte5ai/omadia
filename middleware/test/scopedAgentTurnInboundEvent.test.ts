/**
 * Rollout defect D35 — an `agentTurn@2` that answers a stored message.
 *
 * A process reads its conversation through a subscription of its own
 * (`conversationMessages@2`). The turn service looked the inbound event up
 * only among subscriptions WITHOUT a process, so every such turn of a
 * process-bound engine was refused ("the inbound event is not a stored
 * message of this conversation for this agent"). Nothing tested the two
 * services together; this does, with the real hub.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatTurnInput } from '@omadia/channel-sdk';
import type { ExecutionAuthorizationService, ScopedAgentTurnRequest } from '@omadia/plugin-api';

import { meterModelCalls } from '../packages/harness-usage-telemetry/src/index.js';
import { admitModelCall } from '../packages/llm-provider-api/src/index.js';
import { wrapFacilitatorAgent } from '../packages/harness-orchestrator/src/facilitatorAgent.js';
import { AgentTurnBudget, AgentTurnHistory, createScopedAgentTurnService } from '../src/agents/agentTurnService.js';
import { ConversationMessageHub, type ProcessAccess } from '../src/channels/conversationMessages/hub.js';
import {
  createConversationMessagesService,
  createProcessConversationMessagesService,
} from '../src/channels/conversationMessages/service.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { CONVERSATION, ENGINE, MARA_KEY, messageEvent } from './_helpers/conversationMessagesFixture.js';

const OTHER_PLUGIN = '@acme/other-archetype';

function setup() {
  const access = new Map<string, ProcessAccess>();
  const hub = new ConversationMessageHub({
    store: new InMemoryConversationMessageStore(),
    resolveAgent: (slug) => (slug === 'mara' ? { id: 'id-mara', slug, archetype: 'facilitator' } : undefined),
    identityFor: (slug) => (slug === 'mara' ? { channelKey: MARA_KEY } : undefined),
    isBotPresent: () => Promise.resolve(true),
    checkReadiness: () => Promise.resolve({ ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [] } as never),
    processAccess: ({ pluginId, processId }) =>
      Promise.resolve(access.get(`${pluginId}|${processId}`) ?? { reserved: false, everReserved: false, openScope: false }),
    groundFor: () => Promise.resolve(undefined),
  });
  const grant = (processId: string, pluginId = ENGINE): void => {
    access.set(`${pluginId}|${processId}`, { reserved: true, everReserved: true, openScope: true });
  };
  const turns: ChatTurnInput[] = [];
  const inner: ChatAgent = {
    chat: (input) => {
      admitModelCall();
      turns.push(input);
      return Promise.resolve({ text: 'Noted.' });
    },
    chatStream: (() => undefined) as never,
  };
  const entry = {
    agent: { id: 'id-mara', slug: 'mara', name: 'mara', status: 'enabled', kind: 'facilitator', archetype: 'facilitator' },
    plugins: [{ pluginId: ENGINE, enabled: true }],
    built: { bundle: { agent: wrapFacilitatorAgent(inner, { agentSlug: 'mara' }) } },
  };
  const execution = {
    listScopes: (processId: string) =>
      Promise.resolve([{ id: `scope-${processId}`, agentSlug: 'mara', processId, kind: 'active', state: 'open' }]),
    authorize: (request: { scopeId: string }) =>
      Promise.resolve({ outcome: 'authorized', authorizationId: 'auth-1', scopeId: request.scopeId, remaining: { actions: 9, modelCalls: 5 } }),
    settle: () => Promise.resolve(),
  } as unknown as ExecutionAuthorizationService;
  const turnService = (callerPluginId = ENGINE) =>
    createScopedAgentTurnService({
      getRegistry: () => ({ get: (slug: string) => (slug === 'mara' ? entry : undefined), channelTypesWithIdentity: () => ['teams'] }) as never,
      callerPluginId,
      isEngine: () => true,
      history: new AgentTurnHistory(),
      budget: new AgentTurnBudget(60),
      execution: () => execution,
      meter: meterModelCalls,
      messages: hub,
    });
  const request = (processId: string, inboundEventId: string): ScopedAgentTurnRequest => ({
    agentSlug: 'mara',
    sessionKey: processId,
    channelType: 'teams',
    conversationId: CONVERSATION,
    input: 'Option A for me.',
    inboundEventId,
    scopeId: `scope-${processId}`,
    processId,
    phase: 'active',
    purpose: 'moderation',
    emission: 'prose',
    budget: { modelCalls: 5 },
  });
  const processes = (pluginId = ENGINE) => createProcessConversationMessagesService({ hub, callerPluginId: pluginId });
  const scope = (processId: string) => ({ agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, processId });
  return { hub, grant, turns, turnService, request, processes, scope };
}

describe('D35 — agentTurn@2 answers a message a process received through its own subscription', () => {
  it('runs the turn for an event of the process, as the author the platform stated', async () => {
    const h = setup();
    h.grant('f1');
    assert.equal((await h.processes().subscribe(h.scope('f1'), { mode: 'all' })).outcome, 'subscribed');
    await h.hub.ingest(messageEvent({ messageId: 'u1', text: 'Option A for me.' }));
    const stored = await h.processes().getEvent(h.scope('f1'), 'u1');
    assert.ok(stored, 'the process received the message');

    const outcome = await h.turnService().runTurn(h.request('f1', stored.eventId));
    assert.equal(outcome.outcome, 'completed', JSON.stringify(outcome));
    assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0]?.userId, stored.author.id);
    assert.equal(h.turns[0]?.origin?.principal?.kind, 'user');
  });

  it('refuses an event another process of the same plugin received, and one of another plugin', async () => {
    const h = setup();
    h.grant('f1');
    h.grant('f2');
    await h.processes().subscribe(h.scope('f1'), { mode: 'addressed' });
    await h.processes().subscribe(h.scope('f2'), { mode: 'all' });
    await h.processes().bindMessage(h.scope('f1'), { messageId: 'reminder-1' });
    // A reply bound to F1 is stored for F1 alone.
    await h.hub.ingest(messageEvent({ messageId: 'u2', text: 'done', replyToMessageId: 'reminder-1' }));
    const ofF1 = await h.processes().getEvent(h.scope('f1'), 'u2');
    assert.ok(ofF1);

    const asF2 = await h.turnService().runTurn(h.request('f2', ofF1.eventId));
    assert.equal(asF2.outcome, 'refused');
    assert.match((asF2 as { message: string }).message, /not a stored message of this conversation/);

    const asOther = await h.turnService(OTHER_PLUGIN).runTurn(h.request('f1', ofF1.eventId));
    assert.equal(asOther.outcome, 'refused');
    assert.deepEqual(h.turns, []);
  });

  it('still finds an event of a subscription without a process (the first major)', async () => {
    const h = setup();
    const v1 = createConversationMessagesService({ hub: h.hub, callerPluginId: ENGINE, isEngine: () => true } as never);
    const scope = { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION };
    assert.equal((await v1.subscribe(scope)).outcome, 'subscribed');
    await h.hub.ingest(messageEvent({ messageId: 'u3', text: 'hello' }));
    const stored = await v1.getEvent(scope, 'u3');
    assert.ok(stored);
    const outcome = await h.turnService().runTurn(h.request('f1', stored.eventId));
    assert.equal(outcome.outcome, 'completed', JSON.stringify(outcome));
  });

  it('refuses an event id that is stored nowhere', async () => {
    const h = setup();
    h.grant('f1');
    await h.processes().subscribe(h.scope('f1'), { mode: 'all' });
    const outcome = await h.turnService().runTurn(h.request('f1', '999999'));
    assert.equal(outcome.outcome, 'refused');
  });
});
