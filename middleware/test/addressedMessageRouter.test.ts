/**
 * #2089 — one owner for a message that addresses a facilitator while one of
 * its processes listens for such messages (a facilitation in follow-up).
 *
 * The mention arrives as a turn and as an event. The turn asks the process's
 * plugin and exactly one of the two answers; the hub stores the event for the
 * process without pushing it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatAgent, ChatTurnInput } from '@omadia/channel-sdk';
import { runAsEngineTurn, wrapFacilitatorAgent } from '@omadia/orchestrator';
import type { AddressedMessageRequest, ProcessConversationMessageRecord } from '@omadia/plugin-api';

import { AddressedMessageRouter, type AddressedListener } from '../src/channels/addressedMessageRouter.js';
import { ConversationMessageHub, type ProcessAccess } from '../src/channels/conversationMessages/hub.js';
import { createProcessConversationMessagesService } from '../src/channels/conversationMessages/service.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { createFacilitatorRuntimeLookup } from '../src/platform/facilitatorRuntimeService.js';
import { CONVERSATION, ENGINE, MARA_KEY, messageEvent } from './_helpers/conversationMessagesFixture.js';

const OTHER_PLUGIN = '@acme/other-archetype';
const TURN = {
  agentSlug: 'mara',
  channelType: 'teams',
  conversationIds: ['teams-raw-scope', CONVERSATION],
  principalId: 'aad-anna',
  text: '@Mara is my task still open?',
  messageId: 'm-7',
};

function router(listeners: readonly (AddressedListener & { conversationId?: string })[], opts: { timeoutMs?: number; events?: Record<string, string> } = {}) {
  const logs: string[] = [];
  const made = new AddressedMessageRouter({
    listeners: (scope) =>
      scope.agentSlug === 'mara' ? listeners.filter((l) => (l.conversationId ?? CONVERSATION) === scope.conversationId) : [],
    eventIdOf: (scope, pluginId, messageId) => Promise.resolve(opts.events?.[`${pluginId}|${scope.processId}|${messageId}`]),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    log: (m) => logs.push(m),
  });
  return { router: made, logs };
}

describe('#2089 AddressedMessageRouter', () => {
  it('asks the plugin of the listening processes with what the turn knows, and its yes takes the message', async () => {
    const { router: r } = router(
      [
        { pluginId: ENGINE, processId: 'f1' },
        { pluginId: ENGINE, processId: 'f2' },
        { pluginId: OTHER_PLUGIN, processId: 'x9' },
      ],
      { events: { [`${ENGINE}|f2|m-7`]: 'evt-42' } },
    );
    const seen: AddressedMessageRequest[] = [];
    r.register(ENGINE, 'mara', (request) => {
      seen.push(request);
      return Promise.resolve({ handled: true });
    });
    assert.equal(await r.route(TURN), true);
    assert.deepEqual(seen, [
      {
        agentSlug: 'mara',
        channelType: 'teams',
        conversationId: CONVERSATION,
        principalId: 'aad-anna',
        text: '@Mara is my task still open?',
        messageId: 'm-7',
        eventId: 'evt-42',
        processIds: ['f1', 'f2'],
      },
    ]);
  });

  it('goes without message and event id when the channel states none or the event is not stored', async () => {
    const { router: r } = router([{ pluginId: ENGINE, processId: 'f1' }]);
    const seen: AddressedMessageRequest[] = [];
    r.register(ENGINE, 'mara', (request) => {
      seen.push(request);
      return Promise.resolve({ handled: false });
    });
    const { messageId: _omitted, ...withoutId } = TURN;
    assert.equal(await r.route(withoutId), false);
    assert.equal(await r.route(TURN), false);
    assert.deepEqual(seen.map((s) => [s.messageId, s.eventId]), [[undefined, undefined], ['m-7', undefined]]);
    assert.ok(!('eventId' in seen[1]!));
  });

  it('nobody is asked without a listening process, without a handler, or for another agent or plugin', async () => {
    let asked = 0;
    const count = () => {
      asked += 1;
      return Promise.resolve({ handled: true });
    };
    const none = router([]);
    none.router.register(ENGINE, 'mara', count);
    assert.equal(await none.router.route(TURN), false);

    const noHandler = router([{ pluginId: ENGINE, processId: 'f1' }]);
    assert.equal(await noHandler.router.route(TURN), false);

    const others = router([{ pluginId: OTHER_PLUGIN, processId: 'x9' }]);
    others.router.register(ENGINE, 'mara', count);
    others.router.register(OTHER_PLUGIN, 'finn', count);
    assert.equal(await others.router.route(TURN), false);
    assert.equal(asked, 0);
  });

  it('a decline, a failure and a handler that is too slow all leave the turn to the agent', async () => {
    const declined = router([{ pluginId: ENGINE, processId: 'f1' }]);
    declined.router.register(ENGINE, 'mara', () => Promise.resolve({ handled: false }));
    assert.equal(await declined.router.route(TURN), false);

    const failing = router([{ pluginId: ENGINE, processId: 'f1' }]);
    failing.router.register(ENGINE, 'mara', () => Promise.reject(new Error('engine down')));
    assert.equal(await failing.router.route(TURN), false);
    assert.ok(failing.logs.some((l) => l.includes('engine down')));

    const slow = router([{ pluginId: ENGINE, processId: 'f1' }], { timeoutMs: 20 });
    slow.router.register(ENGINE, 'mara', () => new Promise((resolve) => setTimeout(() => resolve({ handled: true }), 200)));
    assert.equal(await slow.router.route(TURN), false);
    assert.ok(slow.logs.some((l) => l.includes('did not answer in time')));
  });

  it('a removed handler is not asked again, and no longer owns the turns', async () => {
    const { router: r } = router([{ pluginId: ENGINE, processId: 'f1' }]);
    const off = r.register(ENGINE, 'mara', () => Promise.resolve({ handled: true }));
    assert.equal(r.owns(ENGINE, 'mara'), true);
    assert.equal(r.owns(ENGINE, 'finn'), false);
    assert.equal(r.owns(OTHER_PLUGIN, 'mara'), false);
    off();
    assert.equal(r.owns(ENGINE, 'mara'), false);
    assert.equal(await r.route(TURN), false);
  });
});

function hubSetup() {
  const store = new InMemoryConversationMessageStore();
  const access = new Map<string, ProcessAccess>();
  const addressed = new AddressedMessageRouter({
    listeners: (scope) => hub.addressedListeners(scope),
    eventIdOf: async (scope, pluginId, messageId) => {
      const record = await hub.getProcessEvent(scope, pluginId, messageId, 0);
      return record?.kind === 'created' ? record.eventId : undefined;
    },
  });
  const hub: ConversationMessageHub = new ConversationMessageHub({
    store,
    resolveAgent: (slug) => (slug === 'mara' ? { id: 'id-mara', slug, archetype: 'facilitator' } : undefined),
    identityFor: (slug) => (slug === 'mara' ? { channelKey: MARA_KEY } : undefined),
    isBotPresent: () => Promise.resolve(true),
    checkReadiness: () => Promise.resolve({ ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [] } as never),
    processAccess: ({ pluginId, processId }) =>
      Promise.resolve(access.get(`${pluginId}|${processId}`) ?? { reserved: false, everReserved: false, openScope: false }),
    groundFor: () => Promise.resolve(undefined),
    ownsAddressedTurns: (pluginId, agentSlug) => addressed.owns(pluginId, agentSlug),
  });
  const service = createProcessConversationMessagesService({ hub, callerPluginId: ENGINE, addressedMessages: addressed });
  const scope = (processId: string) => ({ agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, processId });
  const grant = (processId: string, a: Partial<ProcessAccess> = {}): void => {
    access.set(`${ENGINE}|${processId}`, { reserved: true, everReserved: true, openScope: true, ...a });
  };
  const live: ProcessConversationMessageRecord[] = [];
  service.onMessage('mara', (record) => void live.push(record));
  const pushed = async (): Promise<string[]> => {
    await new Promise((r) => setImmediate(r));
    return live.map((r) => `${r.processId}:${r.messageId}`).sort();
  };
  return { hub, service, scope, grant, pushed, addressed };
}

describe('#2089 the hub leaves a mention to the turn once the plugin decides addressed turns', () => {
  it('without a handler a mention is pushed to the listening process, as before', async () => {
    const h = hubSetup();
    h.grant('f1', { reserved: false });
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    await h.hub.ingest(messageEvent({ messageId: 'u1', text: '@Mara status', addressedToBot: true }));
    assert.deepEqual(await h.pushed(), ['f1:u1']);
  });

  it('with a handler the mention is stored for the process but not pushed; the turn gets its event id', async () => {
    const h = hubSetup();
    h.grant('f1', { reserved: false });
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    const seen: AddressedMessageRequest[] = [];
    h.service.onAddressedMessage!('mara', (request) => {
      seen.push(request);
      return Promise.resolve({ handled: true });
    });
    await h.hub.ingest(messageEvent({ messageId: 'u1', text: '@Mara status', addressedToBot: true }));
    assert.deepEqual(await h.pushed(), []);
    const stored = await h.service.getEvent(h.scope('f1'), 'u1');
    assert.equal(stored?.text, '@Mara status');
    assert.deepEqual((await h.service.listSince(h.scope('f1'))).events.map((e) => e.messageId), ['u1']);

    assert.equal(
      await h.addressed.route({ agentSlug: 'mara', channelType: 'teams', conversationIds: [CONVERSATION], principalId: 'u-anna', text: '@Mara status', messageId: 'u1' }),
      true,
    );
    assert.equal(seen[0]?.eventId, stored?.eventId);
    assert.deepEqual(seen[0]?.processIds, ['f1']);
  });

  it('replies and card answers bound to the process are still pushed', async () => {
    const h = hubSetup();
    h.grant('f1', { reserved: false });
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    h.service.onAddressedMessage!('mara', () => Promise.resolve({ handled: true }));
    assert.equal(await h.service.bindMessage(h.scope('f1'), { messageId: 'reminder-1', cardId: 'card-1' }), true);
    await h.hub.ingest(messageEvent({ messageId: 'u2', text: '@Mara erledigt', replyToMessageId: 'reminder-1', addressedToBot: true }));
    await h.hub.ingest(messageEvent({ messageId: 'card-msg-1', kind: 'card_answer', text: undefined, cardAnswer: { cardId: 'card-1', value: { done: true } } }));
    assert.deepEqual(await h.pushed(), ['f1:card-msg-1', 'f1:u2']);
  });

  it('a card answer never stands in for the message: the turn of a card click gets no event id', async () => {
    const h = hubSetup();
    h.grant('f1', { reserved: false });
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    const seen: AddressedMessageRequest[] = [];
    h.service.onAddressedMessage!('mara', (request) => {
      seen.push(request);
      return Promise.resolve({ handled: false });
    });
    await h.service.bindMessage(h.scope('f1'), { cardId: 'card-1' });
    await h.hub.ingest(messageEvent({ messageId: 'card-msg-1', kind: 'card_answer', text: undefined, cardAnswer: { cardId: 'card-1', value: { done: true } } }));
    await h.addressed.route({ agentSlug: 'mara', channelType: 'teams', conversationIds: [CONVERSATION], principalId: 'u-anna', text: '', messageId: 'card-msg-1' });
    assert.equal(seen[0]?.messageId, 'card-msg-1');
    assert.equal(seen[0]?.eventId, undefined);
  });

  it('where another process reads everything the turn asks nobody, so the mention is pushed to both', async () => {
    const h = hubSetup();
    h.grant('f1', { reserved: false });
    h.grant('f2');
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    await h.service.subscribe(h.scope('f2'), { mode: 'all' });
    h.service.onAddressedMessage!('mara', () => Promise.resolve({ handled: true }));
    await h.hub.ingest(messageEvent({ messageId: 'u3', text: '@Mara stop', addressedToBot: true }));
    assert.deepEqual(await h.pushed(), ['f1:u3', 'f2:u3']);
  });

  it('the runtime lookup hands a group turn to the router', async () => {
    const h = hubSetup();
    h.grant('f1', { reserved: false });
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    h.service.onAddressedMessage!('mara', () => Promise.resolve({ handled: true }));
    const lookup = createFacilitatorRuntimeLookup({
      getRegistry: () => undefined,
      getMessages: () => h.hub,
      engineSources: () => ({}) as never,
      reportedEngineState: () => undefined,
      getAddressedMessages: () => h.addressed,
    });
    const message = { channelType: 'teams', conversationIds: [CONVERSATION], principalId: 'u-anna', text: '@Mara status' };
    assert.equal(await lookup.addressedTurn?.('mara', message), true);
    assert.equal(await lookup.addressedTurn?.('finn', message), false);
  });
});

describe('#2089 the facilitator answers a mention through its model only when no process takes it', () => {
  const modelAnswer = { text: 'model answer', toolCalls: 0, iterations: 1 } as never;
  const groupTurn = {
    userMessage: '@Mara is my task still open?',
    origin: {
      channelType: 'teams',
      scope: { kind: 'group', groupId: 'g1' },
      conversationType: 'group',
      channelConversationId: CONVERSATION,
      messageId: 'm-7',
      principal: { kind: 'user', userId: 'aad-anna' },
    },
  } as unknown as ChatTurnInput;
  const inner = (calls: string[]): ChatAgent => ({
    chat: () => {
      calls.push('model');
      return Promise.resolve(modelAnswer);
    },
    async *chatStream() {
      calls.push('model');
      yield { type: 'done', answer: 'model answer', toolCalls: 0, iterations: 1 } as never;
    },
  });
  const base = { agentSlug: 'mara', isEngineUsable: () => true, isEngineDriven: () => false };

  it('a process takes it: the turn is silent and the model does not run', async () => {
    const calls: string[] = [];
    const seen: unknown[] = [];
    const agent = wrapFacilitatorAgent(inner(calls), {
      ...base,
      addressedTurn: (agentSlug, message) => {
        seen.push({ agentSlug, message });
        return Promise.resolve(true);
      },
    });
    assert.equal((await agent.chat(groupTurn)).text, '');
    const events = [];
    for await (const event of agent.chatStream(groupTurn)) events.push(event);
    assert.deepEqual(events.map((e) => e.type), ['done']);
    assert.equal((events[0] as { answer: string }).answer, '');
    assert.deepEqual(calls, []);
    assert.deepEqual(seen[0], {
      agentSlug: 'mara',
      message: {
        channelType: 'teams',
        conversationIds: [CONVERSATION],
        principalId: 'aad-anna',
        text: '@Mara is my task still open?',
        messageId: 'm-7',
      },
    });
  });

  it('a link request taken with a short answer: that text is the turn\'s answer, the model does not run', async () => {
    const calls: string[] = [];
    const agent = wrapFacilitatorAgent(inner(calls), {
      ...base,
      addressedTurn: () => Promise.resolve({ answer: 'Please ask from inside the meeting chat.' }),
    });
    assert.equal((await agent.chat(groupTurn)).text, 'Please ask from inside the meeting chat.');
    const events = [];
    for await (const event of agent.chatStream(groupTurn)) events.push(event);
    assert.deepEqual(events.map((e) => e.type), ['text_delta', 'done']);
    assert.deepEqual(calls, []);
  });

  it('nobody takes it, or the lookup fails: the model answers', async () => {
    for (const addressedTurn of [() => Promise.resolve(false), () => Promise.reject(new Error('down'))]) {
      const calls: string[] = [];
      const agent = wrapFacilitatorAgent(inner(calls), { ...base, addressedTurn });
      assert.equal((await agent.chat(groupTurn)).text, 'model answer');
      assert.deepEqual(calls, ['model']);
    }
  });

  it('is not asked where it cannot apply: an engine turn, an engine-driven conversation, no usable engine, a private chat, an unknown author', async () => {
    let asked = 0;
    const addressedTurn = () => {
      asked += 1;
      return Promise.resolve(true);
    };
    const calls: string[] = [];
    const agent = wrapFacilitatorAgent(inner(calls), { ...base, addressedTurn });
    await runAsEngineTurn({ pluginId: ENGINE }, () => agent.chat(groupTurn));
    assert.deepEqual(calls, ['model'], 'an engine turn is the moderation itself');

    await wrapFacilitatorAgent(inner([]), { ...base, isEngineDriven: () => true, addressedTurn }).chat(groupTurn);
    await wrapFacilitatorAgent(inner([]), { ...base, isEngineUsable: () => false, addressedTurn }).chat(groupTurn);
    const personal = { ...groupTurn, origin: { ...groupTurn.origin!, scope: { kind: 'personal', userId: 'aad-anna' }, conversationType: 'direct' } } as unknown as ChatTurnInput;
    await wrapFacilitatorAgent(inner([]), { ...base, addressedTurn }).chat(personal);
    const anonymous = { ...groupTurn, origin: { ...groupTurn.origin!, principal: undefined } } as unknown as ChatTurnInput;
    assert.equal((await wrapFacilitatorAgent(inner([]), { ...base, addressedTurn }).chat(anonymous)).text, 'model answer');
    assert.equal(asked, 0);
  });
});
