/**
 * Spec 2042 §5.3 × §5.12 — triggers and routines deliver through the bot the
 * conversation came through, and an agent's own bot never feeds its hooks.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { SemanticAnswer } from '@omadia/channel-sdk';

import { createRoutinesIntegration } from '../src/plugins/routines/integration.js';
import type { RoutinesHandle } from '../src/plugins/routines/initRoutines.js';
import { InMemoryProactiveSenderRegistry, type ProactiveSender } from '../src/plugins/routines/proactiveSender.js';
import { routineTurnContext } from '../src/plugins/routines/routineTurnContext.js';
import { asChannelKeyOf, isOwnBotAuthor } from '../src/triggers/ownBot.js';
import { createProactiveGate } from '../src/triggers/proactiveGate.js';
import { TriggerService } from '../src/triggers/triggerService.js';
import type { Trigger } from '../src/triggers/types.js';

const MIRA_BOT = 'tg:7000000001';
const SPEAKER = { kind: 'agent', agentId: 'id-mira', slug: 'mira', displayName: 'Mira' } as const;

describe('isOwnBotAuthor', () => {
  it('matches the author id under the channel prefix, and the key itself', () => {
    assert.equal(isOwnBotAuthor(MIRA_BOT, '7000000001'), true);
    assert.equal(isOwnBotAuthor('discord-app:1234', '1234'), true);
    assert.equal(isOwnBotAuthor('slack-bot:u0abc', 'U0ABC'), true);
    assert.equal(isOwnBotAuthor('28:3d78d742', '28:3D78D742'), true);
  });

  it('never matches another author, a blank one or an agent without a bot', () => {
    assert.equal(isOwnBotAuthor(MIRA_BOT, '7000000002'), false);
    assert.equal(isOwnBotAuthor(MIRA_BOT, '000000001'), false);
    assert.equal(isOwnBotAuthor(MIRA_BOT, ' '), false);
    assert.equal(isOwnBotAuthor(undefined, '7000000001'), false);
  });
});

describe('asChannelKeyOf', () => {
  it('reads the bot a delivery ref names, normalised; none for the shared bot', () => {
    assert.equal(asChannelKeyOf({ kind: 'channel', conversationId: '42', asChannelKey: ' Slack-Bot:U0ABC ' }), 'slack-bot:u0abc');
    assert.equal(asChannelKeyOf({ kind: 'channel', conversationId: '42' }), undefined);
    assert.equal(asChannelKeyOf({ asChannelKey: '' }), undefined);
    assert.equal(asChannelKeyOf('42'), undefined);
  });
});

function trigger(deliveryRef: unknown): Trigger {
  return {
    id: 't-1',
    agentId: 'id-mira',
    agentSlug: 'mira',
    origin: 'agent',
    contextKind: 'conversation',
    contextId: 'telegram:42',
    liveContext: false,
    deliveryChannel: 'telegram',
    deliveryRef,
  } as unknown as Trigger;
}

function gateWith(ownKey: string | undefined) {
  const sent: Array<{ conversationRef: unknown; message: SemanticAnswer }> = [];
  const registry = new InMemoryProactiveSenderRegistry();
  const sender: ProactiveSender = {
    channel: 'telegram',
    async send(opts) {
      sent.push({ conversationRef: opts.conversationRef, message: opts.message as SemanticAnswer });
    },
  };
  registry.register(sender);
  const gate = createProactiveGate({
    profiles: { recordDelivery: async () => undefined } as never,
    defaults: {} as never,
    senders: () => registry,
    ownChannelKey: (slug, channel) => (slug === 'mira' && channel === 'telegram' ? ownKey : undefined),
  });
  return { gate, sent };
}

describe('proactive gate and an own bot', () => {
  const viaMira = { kind: 'channel', channelId: '@omadia/channel-telegram', conversationId: '42', asChannelKey: MIRA_BOT };

  it("delivers through the agent's own bot while it is still the agent's", async () => {
    const { gate, sent } = gateWith(MIRA_BOT);
    const outcome = await gate.send(trigger(viaMira), { text: 'Reminder', speaker: SPEAKER } as SemanticAnswer);
    assert.deepEqual(outcome, { delivered: true });
    assert.deepEqual(sent[0]?.conversationRef, viaMira);
    assert.equal(sent[0]?.message.speaker?.kind, 'agent');
  });

  it('refuses when the bot is no longer the agent\'s (removed, or given to another agent)', async () => {
    for (const ownKey of [undefined, 'tg:7000000009']) {
      const { gate, sent } = gateWith(ownKey);
      const outcome = await gate.send(trigger(viaMira), { text: 'Reminder' } as SemanticAnswer);
      assert.equal(outcome.delivered, false);
      assert.match((outcome as { reason: string }).reason, /no longer mira's/);
      assert.equal(sent.length, 0);
    }
  });

  it('refuses before any model turn: the send window drops a bot that is no longer the agent\'s', async () => {
    const { gate } = gateWith('tg:7000000009');
    assert.deepEqual(await gate.sendWindow(trigger(viaMira), new Date()), { ok: false, drop: 'bot_no_longer_agents' });
  });

  it('a conversation of the shared bot is delivered as before', async () => {
    const { gate, sent } = gateWith(undefined);
    const outcome = await gate.send(trigger({ kind: 'channel', conversationId: '42' }), { text: 'Reminder' } as SemanticAnswer);
    assert.deepEqual(outcome, { delivered: true });
    assert.equal(sent.length, 1);
  });
});

describe('routines integration for channels without tenants', () => {
  it('a turn with conductorBinding false opens the scope but binds nothing for reminders', async () => {
    const captured: unknown[] = [];
    const integ = createRoutinesIntegration({} as RoutinesHandle, (info) => captured.push(info));
    const run = integ.beginRoutineTurn({ userId: 'u-1', channel: 'telegram', conversationRef: { conversationId: '-100777' }, conductorBinding: false });
    assert.equal(await run(async () => routineTurnContext.current()?.userId), 'u-1');
    assert.deepEqual(captured, []);
  });

  it('publishProactiveSend returns a disposer that removes only its own sender', async () => {
    const senderRegistry = new InMemoryProactiveSenderRegistry();
    const integ = createRoutinesIntegration({ senderRegistry } as unknown as RoutinesHandle);
    const first = integ.publishProactiveSend('telegram', async () => undefined);
    const second = integ.publishProactiveSend('telegram', async () => undefined);
    const successor = senderRegistry.get('telegram');
    (first as () => void)();
    assert.equal(senderRegistry.get('telegram'), successor, 'a late dispose of the old instance keeps its successor');
    (second as () => void)();
    assert.equal(senderRegistry.get('telegram'), undefined);
  });

  it("passes the speaker to the channel's proactive send", async () => {
    const senderRegistry = new InMemoryProactiveSenderRegistry();
    const integ = createRoutinesIntegration({ senderRegistry } as unknown as RoutinesHandle);
    const seen: unknown[] = [];
    integ.publishProactiveSend('telegram', async (_ref, message) => {
      seen.push(message);
    });
    await senderRegistry.get('telegram')!.send({ conversationRef: {}, message: { text: 'hi', speaker: SPEAKER } as never });
    assert.deepEqual(seen, [{ text: 'hi', speaker: SPEAKER }]);
  });

  it('files a turn without a tenant under the deployment tenant', async () => {
    const captured: Array<string | undefined> = [];
    const integ = createRoutinesIntegration({} as RoutinesHandle, (info) => captured.push(info.tenant), 'tenant-x');
    const run = integ.beginRoutineTurn({ userId: 'u-1', channel: 'telegram', conversationRef: { kind: 'channel', conversationId: '42' } });
    const tenant = await run(async () => routineTurnContext.current()?.tenant);
    assert.equal(tenant, 'tenant-x');
    assert.deepEqual(captured, ['tenant-x']);
  });
});

describe('hooks and an own bot', () => {
  async function heard(hookRef: unknown, receivedByChannelKey: string): Promise<number> {
    const hook = {
      id: 'h-1',
      agentId: 'id-mira',
      agentSlug: 'mira',
      origin: 'agent',
      contextKind: 'conversation',
      contextId: 'telegram:42',
      deliveryChannel: 'telegram',
      deliveryRef: hookRef,
      eventFilter: null,
    } as unknown as Trigger;
    const service = new TriggerService({
      store: {
        noteActivity: async () => undefined,
        listHooks: async () => [hook],
        enqueueEvent: async () => true,
      } as never,
      limits: {} as never,
      eventSources: () => [],
    } as never);
    return service.onEvent(
      'conversation.message.created',
      { channelType: 'telegram', conversationId: '42', messageId: 'm1', authorId: '42', receivedByChannelKey },
      'telegram:42:m1',
    );
  }

  it("a hook set on an agent's own bot hears only what that bot received (a Telegram DM has one chat id for every bot)", async () => {
    const viaMira = { kind: 'channel', conversationId: '42', asChannelKey: MIRA_BOT };
    assert.equal(await heard(viaMira, MIRA_BOT), 1);
    assert.equal(await heard(viaMira, 'tg:7000000002'), 0);
    assert.equal(await heard(viaMira, 'tg:999'), 0);
  });

  it('a hook of the shared bot hears the conversation as before', async () => {
    assert.equal(await heard({ kind: 'channel', conversationId: '42' }, 'tg:999'), 1);
  });
});
