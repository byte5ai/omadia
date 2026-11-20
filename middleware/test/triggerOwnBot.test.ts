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

  it('a conversation of the shared bot is delivered as before', async () => {
    const { gate, sent } = gateWith(undefined);
    const outcome = await gate.send(trigger({ kind: 'channel', conversationId: '42' }), { text: 'Reminder' } as SemanticAnswer);
    assert.deepEqual(outcome, { delivered: true });
    assert.equal(sent.length, 1);
  });
});

describe('routines integration for channels without tenants', () => {
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
