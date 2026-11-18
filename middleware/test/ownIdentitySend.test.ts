/**
 * #2043 — sending as an agent's OWN channel identity.
 *
 * A facilitator never speaks through another bot. These tests pin the two
 * send services' `asOwnIdentity` / `asAgentSlug` branches, that a
 * conversation send has no other scope any more, and that a targeted send
 * without `asAgentSlug` behaves as before.
 */

import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import type {
  ConversationRoster,
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedSendOptions,
} from '@omadia/channel-sdk';

import { ConversationSendRegistry } from '../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../src/channels/conversationSendService.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { channelUserIdOf, readPoll } from '../src/channels/ownIdentitySend.js';
import { createTargetedDeliveryService } from '../src/channels/targetedDeliveryService.js';
import { TargetedSendRegistry } from '../src/channels/targetedSendRegistry.js';
import {
  CONVERSATION,
  ENGINE,
  hubFixture,
  MARA_KEY,
  messageEvent,
  scopeOf,
  type HubFixture,
} from './_helpers/conversationMessagesFixture.js';

const ANNA = '5f0c1a2b-0000-4000-8000-00000000a11a';
const BEN = '5f0c1a2b-0000-4000-8000-00000000be11';

interface Sent {
  target: string;
  message: TargetedMessage;
  opts: unknown;
  userRef?: unknown;
  conversationRef?: unknown;
}

describe('own-identity sends', () => {
  let f: HubFixture;
  let sent: Sent[];
  let nextOutcome: TargetedDeliveryOutcome;
  let roster: ConversationRoster | undefined;
  let identities: Record<string, string | undefined>;
  let conversationSend: ReturnType<typeof createConversationSendService>;
  let targetedSend: ReturnType<typeof createTargetedDeliveryService>;

  /** Read through a call, so an earlier "nothing was sent" assertion does not
   *  narrow the array's type for the rest of the test. */
  const recorded = (): Sent[] => sent;

  beforeEach(async () => {
    f = hubFixture(new InMemoryConversationMessageStore());
    sent = [];
    nextOutcome = { outcome: 'delivered', messageId: 'msg-1' };
    roster = {
      conversationType: 'group',
      partial: false,
      participants: [
        { userRef: { kind: 'teams-aad', id: ANNA, displayName: 'Anna Köhler' }, externalId: '29:anna-per-bot' },
        { userRef: { kind: 'teams-aad', id: BEN, displayName: 'Ben' } },
        { userRef: { kind: 'teams-aad', id: 'bot-guid' }, isBot: true },
      ],
    };
    identities = { mara: MARA_KEY, nora: '28:bbbb-nora' };
    const ownIdentity = {
      identityFor: (slug: string) => (identities[slug] ? { channelKey: identities[slug]! } : undefined),
      subscriptions: f.hub,
      getRoster: () => Promise.resolve(roster),
    };
    const conversationProviders = new ConversationSendRegistry();
    conversationProviders.register('@omadia/channel-teams', {
      channelType: 'teams',
      supports: { asChannelKey: true, mentions: true, poll: true },
      sendToConversation: (conversationId, message, opts) => {
        sent.push({ target: conversationId, message, opts });
        return Promise.resolve(nextOutcome);
      },
    });
    const targetedProviders = new TargetedSendRegistry();
    targetedProviders.register('@omadia/channel-teams', {
      channelType: 'teams',
      supports: { asChannelKey: true },
      sendToUser: (target, message, opts?: TargetedSendOptions) => {
        sent.push({
          target: target.principalId,
          message,
          opts,
          userRef: target.userRef,
          conversationRef: target.conversationRef,
        });
        return Promise.resolve(nextOutcome);
      },
    });
    conversationSend = createConversationSendService({
      providers: conversationProviders,
      ownIdentity,
    });
    targetedSend = createTargetedDeliveryService({
      providers: targetedProviders,
      lookupConversationRefs: () => Promise.resolve(new Map([[ANNA, { ref: 'default-bot-1:1' }]])),
      ownIdentity,
    });
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
  });

  const post = (over: Record<string, unknown> = {}, caller: string | undefined = ENGINE) =>
    conversationSend.sendToConversation(
      {
        agentSlug: 'mara',
        channelType: 'teams',
        conversationId: CONVERSATION,
        message: { text: 'Welcome.' },
        asOwnIdentity: true,
        ...over,
      } as never,
      caller,
    );

  describe('conversationSend', () => {
    it('posts as the agent own bot and returns the provider message id', async () => {
      assert.deepEqual(await post(), { outcome: 'delivered', messageId: 'msg-1' });
      assert.deepEqual(sent, [
        { target: CONVERSATION, message: { text: 'Welcome.' }, opts: { asChannelKey: MARA_KEY } },
      ]);
    });

    it('refuses with no_identity and never falls back to the default bot', async () => {
      identities['mara'] = undefined;
      const outcome = await post();
      assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'no_identity');
      assert.match(outcome.outcome === 'unreachable' ? outcome.message : '', /does not post through another agent's bot/);
      assert.deepEqual(sent, [], 'nothing was posted, under any identity');
    });

    it('takes its permission from the message subscription, of the calling plugin', async () => {
      const elsewhere = await post({ conversationId: '19:other@thread.v2' });
      assert.equal(elsewhere.outcome === 'unreachable' && elsewhere.code, 'not_permitted');
      const otherAgent = await post({ agentSlug: 'nora' });
      assert.equal(otherAgent.outcome === 'unreachable' && otherAgent.code, 'not_permitted');
      const otherPlugin = await post({}, '@acme/snoop');
      assert.equal(otherPlugin.outcome === 'unreachable' && otherPlugin.code, 'not_permitted');
      assert.deepEqual(sent, []);
      await f.hub.unsubscribe(scopeOf('mara'), ENGINE);
      const after = await post();
      assert.equal(after.outcome === 'unreachable' && after.code, 'not_permitted');
    });

    it('resolves mentions to the channel user reference (Entra object id)', async () => {
      await f.hub.ingest(
        messageEvent({ author: { kind: 'teams-aad', id: 'C0FFEE00-0000-4000-8000-00000000CA41', displayName: 'Carl' } }),
      );
      roster = { ...roster!, participants: roster!.participants.slice(0, 2) };
      await post({
        message: {
          text: '@Anna Köhler, @Ben, @Carl and @Dora: one step is open.',
          mentions: [
            { user: `user:${ANNA}`, text: '@Anna Köhler' }, // canonical principal
            { user: '29:ANNA-PER-BOT', text: '@Anna Köhler' }, // per-bot id → the Entra id
            { user: BEN.toUpperCase(), text: '@Ben' }, // bare id, any case
            { user: 'user:c0ffee00-0000-4000-8000-00000000ca41', text: '@Carl' }, // wrote, not in the roster
            { user: 'user:someone-else', text: '@Dora' }, // not a person of this chat
            { user: 'role:managers', text: '@Managers' },
          ],
        },
      });
      assert.deepEqual(sent[0]!.message.mentions, [
        { user: { kind: 'teams-aad', id: ANNA, displayName: 'Anna Köhler' }, text: '@Anna Köhler' },
        { user: { kind: 'teams-aad', id: ANNA, displayName: 'Anna Köhler' }, text: '@Anna Köhler' },
        { user: { kind: 'teams-aad', id: BEN, displayName: 'Ben' }, text: '@Ben' },
        {
          user: { kind: 'teams-aad', id: 'C0FFEE00-0000-4000-8000-00000000CA41', displayName: 'Carl' },
          text: '@Carl',
        },
      ]);
      assert.match(sent[0]!.message.text, /@Dora/, 'an unknown person stays plain text');
    });

    it('passes a poll through and returns both message ids', async () => {
      nextOutcome = { outcome: 'delivered', messageId: 'text-1', cardMessageId: 'card-1' };
      const poll = {
        pollId: 'poll-7',
        question: 'Which date?',
        options: [
          { id: 'a', label: '12 May' },
          { id: 'b', label: '19 May' },
        ],
        hint: 'One answer each.',
        extra: 'dropped',
      };
      assert.deepEqual(await post({ message: { text: 'Please vote.', poll } }), {
        outcome: 'delivered',
        messageId: 'text-1',
        cardMessageId: 'card-1',
      });
      assert.deepEqual(sent[0]!.message.poll, {
        pollId: 'poll-7',
        question: 'Which date?',
        options: poll.options,
        hint: 'One answer each.',
      });
    });

    it('refuses an invalid poll and posts nothing', async () => {
      const bad: readonly [unknown, RegExp][] = [
        [{ pollId: '', question: 'q', options: [] }, /pollId/],
        [{ pollId: 'p', question: ' ', options: [] }, /question/],
        [{ pollId: 'p', question: 'q', options: [{ id: 'a', label: 'A' }] }, /2\.\.6 options/],
        [{ pollId: 'p', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /not unique/],
        [{ pollId: 'p', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: '' }] }, /label/],
        ['poll', /must be an object/],
      ];
      for (const [poll, pattern] of bad) {
        const outcome = await post({ message: { text: 'x', poll } });
        assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'channel_error');
        assert.match(outcome.outcome === 'unreachable' ? outcome.message : '', pattern);
      }
      assert.deepEqual(sent, []);
      assert.ok('poll' in readPoll({ pollId: 'p', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }));
    });

    it('returns provider unreachability and a provider throw as named outcomes', async () => {
      nextOutcome = { outcome: 'unreachable', code: 'app_not_installed', message: 'not installed in this chat' };
      assert.deepEqual(await post(), nextOutcome);
      const throwing = new ConversationSendRegistry();
      throwing.register('c', {
        channelType: 'teams',
        supports: { asChannelKey: true },
        sendToConversation: () => Promise.reject(new Error('socket hang up')),
      });
      const service = createConversationSendService({
        providers: throwing,
        ownIdentity: { identityFor: () => ({ channelKey: MARA_KEY }), subscriptions: f.hub },
      });
      const outcome = await service.sendToConversation(
        { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, message: { text: 'x' }, asOwnIdentity: true },
        ENGINE,
      );
      assert.deepEqual(outcome, { outcome: 'unreachable', code: 'channel_error', message: 'socket hang up' });
    });

    it('resolves an object-shaped mention from a plugin itself; it is never passed through', async () => {
      await post({
        message: {
          text: '@Ben and @Eve',
          mentions: [
            // A plugin stating a full reference: only the id is taken, and the
            // roster's own reference (kind, display name) is what goes out.
            { user: { kind: 'made-up-kind', id: BEN, displayName: 'Somebody Else' }, text: '@Ben' },
            // …and a person who is not in this conversation is not mentioned,
            // however complete the reference looks.
            { user: { kind: 'teams-aad', id: '99999999-0000-4000-8000-000000000000', displayName: 'Eve' }, text: '@Eve' },
            { user: { kind: 'teams-aad' }, text: '@Nobody' },
          ],
        },
      });
      assert.deepEqual(sent[0]!.message.mentions, [
        { user: { kind: 'teams-aad', id: BEN, displayName: 'Ben' }, text: '@Ben' },
      ]);
    });

    it('a provider that does not declare asChannelKey is never asked: nothing goes out as the default bot', async () => {
      // An older channel plugin: it ignores the third argument and would
      // answer `delivered` after posting through its default bot.
      const legacySent: string[] = [];
      const legacy = new ConversationSendRegistry();
      legacy.register('@omadia/channel-teams', {
        channelType: 'teams',
        sendToConversation: (conversationId) => {
          legacySent.push(conversationId);
          return Promise.resolve({ outcome: 'delivered', messageId: 'from-the-default-bot' });
        },
      });
      const service = createConversationSendService({
        providers: legacy,
        ownIdentity: { identityFor: () => ({ channelKey: MARA_KEY }), subscriptions: f.hub },
      });
      const outcome = await service.sendToConversation(
        { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, message: { text: 'x' }, asOwnIdentity: true },
        ENGINE,
      );
      assert.equal(outcome.outcome === 'unreachable' && outcome.code, 'no_identity');
      assert.match(outcome.outcome === 'unreachable' ? outcome.message : '', /does not declare that it sends as a named identity/);
      assert.deepEqual(legacySent, [], 'the provider was not called at all');
    });

    it('a poll needs a provider that declares polls; mentions degrade to plain text', async () => {
      const got: TargetedMessage[] = [];
      const partial = new ConversationSendRegistry();
      partial.register('c', {
        channelType: 'teams',
        supports: { asChannelKey: true },
        sendToConversation: (_conversationId, message) => {
          got.push(message);
          return Promise.resolve({ outcome: 'delivered' });
        },
      });
      const service = createConversationSendService({
        providers: partial,
        ownIdentity: {
          identityFor: () => ({ channelKey: MARA_KEY }),
          subscriptions: f.hub,
          getRoster: () => Promise.resolve(roster),
        },
      });
      const base = { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION, asOwnIdentity: true };
      const poll = await service.sendToConversation(
        {
          ...base,
          message: {
            text: 'vote',
            poll: { pollId: 'p', question: 'q', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
          },
        },
        ENGINE,
      );
      assert.deepEqual(poll, {
        outcome: 'unreachable',
        code: 'channel_error',
        message: "the 'teams' channel plugin does not declare poll support",
      });
      assert.deepEqual(got, [], 'the question was not posted as plain text instead');
      const mention = await service.sendToConversation(
        { ...base, message: { text: '@Ben hello', mentions: [{ user: `user:${BEN}`, text: '@Ben' }] } },
        ENGINE,
      );
      assert.equal(mention.outcome, 'delivered');
      assert.deepEqual(got, [{ text: '@Ben hello' }]);
    });

    it('without the flag the send is refused: there is no other scope', async () => {
      const refused = await post({ asOwnIdentity: undefined });
      assert.equal(refused.outcome === 'unreachable' && refused.code, 'not_permitted');
      assert.match(refused.outcome === 'unreachable' ? refused.message : '', /set asOwnIdentity/);
      assert.deepEqual(sent, []);
    });
  });

  describe('targetedSend', () => {
    const dm = (over: Record<string, unknown> = {}, caller: string | undefined = ENGINE) =>
      targetedSend.sendToPrincipal(
        {
          channelType: 'teams',
          principal: `user:${ANNA}`,
          message: { text: 'One step is still open for you.' },
          asAgentSlug: 'mara',
          ...over,
        } as never,
        caller,
      );

    it('sends as the agent own bot with the recipient channel reference (first contact)', async () => {
      const report = await dm();
      assert.deepEqual(report.deliveries, [
        { principalId: ANNA, outcome: { outcome: 'delivered', messageId: 'msg-1' } },
      ]);
      assert.deepEqual(report.diagnostics, []);
      assert.deepEqual(sent, [
        {
          target: ANNA,
          message: { text: 'One step is still open for you.' },
          opts: { asChannelKey: MARA_KEY },
          userRef: { kind: 'teams-aad', id: ANNA, displayName: 'Anna Köhler' },
          conversationRef: { ref: 'default-bot-1:1' },
        },
      ]);
    });

    it('accepts the channel-native id as principal and a stated userRef of the same person', async () => {
      await dm({ principal: `user:${BEN.toUpperCase()}`, userRef: { kind: 'teams-aad', id: BEN.toUpperCase() } });
      assert.deepEqual(sent[0]!.userRef, { kind: 'teams-aad', id: BEN, displayName: 'Ben' });
      // A stated reference naming somebody else is ignored; the kernel's lookup decides.
      await dm({ userRef: { kind: 'teams-aad', id: BEN } });
      assert.deepEqual((sent[1]!.userRef as { id: string }).id, ANNA);
    });

    it('refuses with no_identity, never the default bot', async () => {
      identities['mara'] = undefined;
      const report = await dm();
      assert.equal(report.deliveries[0]!.outcome.outcome, 'unreachable');
      assert.equal((report.deliveries[0]!.outcome as { code: string }).code, 'no_identity');
      assert.equal(report.diagnostics[0]!.code, 'holder_unreachable');
      assert.deepEqual(sent, []);
    });

    it('writes only to people of a conversation the agent moderates', async () => {
      const stranger = await dm({ principal: 'user:11111111-0000-4000-8000-000000000000' });
      assert.equal((stranger.deliveries[0]!.outcome as { code: string }).code, 'not_permitted');
      const otherAgent = await dm({ asAgentSlug: 'nora' });
      assert.equal((otherAgent.deliveries[0]!.outcome as { code: string }).code, 'not_permitted');
      const otherPlugin = await dm({}, '@acme/snoop');
      assert.equal((otherPlugin.deliveries[0]!.outcome as { code: string }).code, 'not_permitted');
      assert.deepEqual(sent, []);
      // Without a roster provider, having written in the conversation is enough.
      roster = undefined;
      assert.equal((await dm()).deliveries[0]!.outcome.outcome, 'unreachable');
      await f.hub.ingest(messageEvent({ author: { kind: 'teams-aad', id: ANNA.toUpperCase() } }));
      assert.equal((await dm()).deliveries[0]!.outcome.outcome, 'delivered');
      assert.deepEqual(recorded()[0]!.userRef, { kind: 'teams-aad', id: ANNA.toUpperCase() });
    });

    it('maps app_not_installed and blocked from the provider', async () => {
      for (const code of ['app_not_installed', 'blocked'] as const) {
        nextOutcome = { outcome: 'unreachable', code, message: `403 ${code}` };
        const report = await dm();
        assert.deepEqual(report.deliveries[0]!.outcome, nextOutcome);
        assert.match(report.diagnostics[0]!.message, new RegExp(`${code} — 403 ${code}`));
      }
    });

    it('a provider that does not declare asChannelKey is never asked for a direct message', async () => {
      const legacySent: string[] = [];
      const legacy = new TargetedSendRegistry();
      legacy.register('@omadia/channel-teams', {
        channelType: 'teams',
        sendToUser: (target) => {
          legacySent.push(target.principalId);
          return Promise.resolve({ outcome: 'delivered' });
        },
      });
      const service = createTargetedDeliveryService({
        providers: legacy,
        ownIdentity: {
          identityFor: () => ({ channelKey: MARA_KEY }),
          subscriptions: f.hub,
          getRoster: () => Promise.resolve(roster),
        },
      });
      const report = await service.sendToPrincipal(
        { channelType: 'teams', principal: `user:${ANNA}`, message: { text: 'x' }, asAgentSlug: 'mara' },
        ENGINE,
      );
      assert.equal((report.deliveries[0]!.outcome as { code: string }).code, 'no_identity');
      assert.deepEqual(legacySent, []);
      // The same provider keeps serving ordinary targeted sends.
      const plain = await service.sendToPrincipal({ channelType: 'teams', principal: `user:${ANNA}`, message: { text: 'x' } });
      assert.equal(plain.deliveries[0]!.outcome.outcome, 'delivered');
    });

    it('refuses a role principal for an own-identity send', async () => {
      const report = await dm({ principal: 'role:managers' });
      assert.equal(report.diagnostics[0]!.code, 'invalid_principal');
      assert.deepEqual(report.deliveries, []);
      assert.deepEqual(sent, []);
    });

    it('without asAgentSlug nothing changes', async () => {
      const report = await targetedSend.sendToPrincipal({
        channelType: 'teams',
        principal: `user:${ANNA}`,
        message: { text: 'Approval needed.' },
      });
      assert.equal(report.deliveries[0]!.outcome.outcome, 'delivered');
      assert.deepEqual(sent, [
        {
          target: ANNA,
          message: { text: 'Approval needed.' },
          opts: undefined,
          userRef: undefined,
          conversationRef: { ref: 'default-bot-1:1' },
        },
      ]);
    });
  });

  it('channelUserIdOf reads both principal forms', () => {
    assert.equal(channelUserIdOf('user:ABC'), 'abc');
    assert.equal(channelUserIdOf(' ABC '), 'abc');
    assert.equal(channelUserIdOf('29:Xy'), '29:xy');
    assert.equal(channelUserIdOf('role:managers'), undefined);
    assert.equal(channelUserIdOf(''), undefined);
  });
});
