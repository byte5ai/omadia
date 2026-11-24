/**
 * Spec 2042 §5.3 + §5.14, criterion 30, on an agent's OWN Telegram bot (S7).
 *
 * The chain end to end with a `tg:` key and the real registry lookup:
 *   1. the agent's bot is an identity row (`agent_channel_identities`, here as
 *      a snapshot row) → `OrchestratorRegistry.channelIdentityFor` = `tg:<id>`;
 *   2. the agent posts a poll; Telegram declares no poll, so the kernel posts
 *      it as numbered text through exactly that bot (`asChannelKey`) and keeps
 *      the question open;
 *   3. a person answers "2" in reply; the channel reports the message as
 *      received by `tg:<id>` → the hub takes it as the `card_answer`
 *      (`answeredCard: true`, the channel starts no turn);
 *   4. the same reply received by ANOTHER bot (the shared bot) is not this
 *      agent's answer: the question belongs to the identity that posted it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ConversationSendProvider, TargetedMessage } from '@omadia/channel-sdk';
import type { LlmProvider } from '@omadia/llm-provider';
import { InMemoryNudgeRegistry, type EntityRefBus, type KnowledgeGraph, type MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow, ConfigSnapshot, ConfigStore } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';
import { ConversationMessageHub } from '../src/channels/conversationMessages/hub.js';
import { createProcessConversationMessagesService } from '../src/channels/conversationMessages/service.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { ConversationSendRegistry } from '../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../src/channels/conversationSendService.js';
import { InMemoryOpenCardQuestionStore } from '../src/channels/openCardQuestions.js';
import { ENGINE, FULL_ACCESS, messageEvent } from './_helpers/conversationMessagesFixture.js';

const MIRA_ID = '00000000-0000-4000-8000-00000000a7a1';
const MIRA_BOT = 'tg:7000000001';
const SHARED_BOT = 'tg:6999999999';
const GROUP = '-1002000000001';
const READY = { ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [] };

function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
  } as unknown as NativeToolRegistry;
}

function deps(): OrchestratorDeps {
  return {
    provider: {} as LlmProvider,
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  };
}

const mira: AgentRow = {
  id: MIRA_ID,
  slug: 'mira',
  name: 'Mira',
  description: null,
  privacyProfile: 'default',
  status: 'enabled',
  availableToEveryone: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

async function registryWithMiraBot(): Promise<OrchestratorRegistry> {
  const snapshot: ConfigSnapshot = {
    agents: [mira],
    agentPlugins: [],
    channelBindings: [],
    channelIdentities: [{ channelType: 'telegram', channelKey: MIRA_BOT, agentId: MIRA_ID }],
  };
  const registry = new OrchestratorRegistry(
    { loadSnapshot: () => Promise.resolve(snapshot) } as unknown as ConfigStore,
    deps(),
    { defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 } },
  );
  await registry.start();
  return registry;
}

async function setup() {
  const registry = await registryWithMiraBot();
  const identityFor = (slug: string, channelType: string) => registry.channelIdentityFor(slug, channelType);
  const openQuestions = new InMemoryOpenCardQuestionStore();
  const posted: Array<{ conversationId: string; message: TargetedMessage; asChannelKey?: string }> = [];
  const telegram: ConversationSendProvider = {
    channelType: 'telegram',
    supports: { asChannelKey: true },
    sendToConversation: (conversationId, message, opts) => {
      posted.push({ conversationId, message, ...(opts?.asChannelKey ? { asChannelKey: opts.asChannelKey } : {}) });
      return Promise.resolve({ outcome: 'delivered', messageId: '4711', conversationId });
    },
  };
  const providers = new ConversationSendRegistry();
  providers.register('@omadia/channel-telegram', telegram);
  const send = createConversationSendService({
    providers,
    ownIdentity: { identityFor } as never,
    openQuestions,
  });
  const hub = new ConversationMessageHub({
    store: new InMemoryConversationMessageStore(),
    typedReplies: { store: openQuestions },
    resolveAgent: (slug) => (slug === 'mira' ? { id: MIRA_ID, slug, archetype: 'facilitator' } : undefined),
    identityFor,
    isBotPresent: () => Promise.resolve(true),
    checkReadiness: () => Promise.resolve(READY),
    processAccess: () => Promise.resolve(FULL_ACCESS),
    groundFor: () => Promise.resolve(undefined),
  });
  const service = createProcessConversationMessagesService({ hub, callerPluginId: ENGINE });
  const scope = { agentSlug: 'mira', channelType: 'telegram', conversationId: GROUP, processId: 'f1' };
  return { registry, send, hub, service, scope, posted, openQuestions };
}

const reply = (receivedBy: string, messageId: string) =>
  messageEvent({
    channelId: '@omadia/channel-telegram',
    channelType: 'telegram',
    conversationId: GROUP,
    receivedByChannelKey: receivedBy,
    messageId,
    text: '2',
    replyToMessageId: '4711',
    addressedToBot: true,
    author: { kind: 'telegram-chat', id: '42', displayName: 'Anna' },
  });

describe("a poll on an agent's own Telegram bot, answered in plain text (criterion 30, S7)", () => {
  it('the registry names the bot as the agent’s identity', async () => {
    const h = await setup();
    assert.deepEqual(h.registry.channelIdentityFor('mira', 'telegram'), { channelType: 'telegram', channelKey: MIRA_BOT });
  });

  it('the poll goes out as numbered text through exactly the agent’s bot and stays open', async () => {
    const h = await setup();
    const outcome = await h.send.sendToConversation(
      {
        agentSlug: 'mira',
        channelType: 'telegram',
        conversationId: GROUP,
        message: { text: 'Mittag?', poll: { pollId: 'poll-1', question: 'Mittag?', options: [{ id: 'pizza', label: 'Pizza' }, { id: 'sushi', label: 'Sushi' }] } },
      } as never,
      { subscriptions: [] } as never,
    );
    assert.equal(outcome.outcome, 'delivered');
    assert.equal(h.posted.length, 1);
    assert.equal(h.posted[0]?.asChannelKey, MIRA_BOT);
    assert.equal(h.posted[0]?.message.poll, undefined, 'Telegram declares no poll: text only');
    assert.match(h.posted[0]?.message.text ?? '', /1\) Pizza[\s\S]*2\) Sushi/);
    const open = await h.openQuestions.listOpen('telegram', GROUP, new Date());
    assert.equal(open[0]?.messageId, '4711');
    assert.equal(open[0]?.agentSlug, 'mira');
  });

  it('a typed "2" received by the agent’s bot is the card_answer, and the channel starts no turn', async () => {
    const h = await setup();
    await h.send.sendToConversation(
      {
        agentSlug: 'mira',
        channelType: 'telegram',
        conversationId: GROUP,
        message: { text: 'Mittag?', poll: { pollId: 'poll-1', question: 'Mittag?', options: [{ id: 'pizza', label: 'Pizza' }, { id: 'sushi', label: 'Sushi' }] } },
      } as never,
      { subscriptions: [] } as never,
    );
    assert.equal((await h.service.subscribe(h.scope, { mode: 'all' })).outcome, 'subscribed');
    assert.deepEqual(await h.hub.report(reply(MIRA_BOT, 'u1')), { answeredCard: true });
    const { events } = await h.service.listSince(h.scope);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'card_answer');
    assert.deepEqual(events[0]?.cardAnswer?.value, { optionId: 'sushi' });
    assert.equal(events[0]?.receivedByChannelKey, MIRA_BOT);
  });

  it('the same reply through the shared bot is not the agent’s answer', async () => {
    const h = await setup();
    await h.send.sendToConversation(
      {
        agentSlug: 'mira',
        channelType: 'telegram',
        conversationId: GROUP,
        message: { text: 'Mittag?', poll: { pollId: 'poll-1', question: 'Mittag?', options: [{ id: 'pizza', label: 'Pizza' }, { id: 'sushi', label: 'Sushi' }] } },
      } as never,
      { subscriptions: [] } as never,
    );
    await h.service.subscribe(h.scope, { mode: 'all' });
    assert.deepEqual(await h.hub.report(reply(SHARED_BOT, 'u2')), { answeredCard: false });
    assert.deepEqual((await h.service.listSince(h.scope)).events, []);
  });
});
