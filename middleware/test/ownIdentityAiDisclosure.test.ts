/**
 * #2043 rollout — one AI marking on what a facilitator posts, never two.
 *
 * In the first live facilitation a model-written post carried the instance's
 * disclosure sentence and no Teams label, the deterministic posts carried
 * neither. Three paths had three behaviours: a turn answer (sentence folded
 * by the kernel, the Teams adapter swaps it for its label), the text
 * `agentTurn` hands the engine (sentence folded, then posted as plain text)
 * and a fixed engine text (nothing).
 *
 * The rule: every message under an agent's name gets the channel's AI label
 * where the channel has one, the instance's sentence otherwise, once.
 */

import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import {
  applyAiDisclosure,
  InMemoryDisclosureSeenStore,
  resolveAiDisclosure,
  withoutFoldedAiDisclosure,
  type AiDisclosure,
  type SendProviderCapabilities,
  type TargetedDeliveryOutcome,
  type TargetedMessage,
} from '@omadia/channel-sdk';

import { ConversationSendRegistry } from '../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../src/channels/conversationSendService.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { markOwnIdentityMessage } from '../src/channels/ownIdentitySend.js';
import { createTargetedDeliveryService } from '../src/channels/targetedDeliveryService.js';
import { TargetedSendRegistry } from '../src/channels/targetedSendRegistry.js';
import { CONVERSATION, ENGINE, hubFixture, MARA_KEY, processOf, readAll } from './_helpers/conversationMessagesFixture.js';

const LINE = 'Diese Antwort wurde von Mara, einem KI-System, erzeugt.';
const ANNA = 'aad-anna';

function disclosure(over: Partial<AiDisclosure> = {}): AiDisclosure {
  return { ...resolveAiDisclosure({ assistantName: 'Mara' })!, ...over };
}

describe('withoutFoldedAiDisclosure', () => {
  it('takes off exactly what a turn folded, and nothing else', () => {
    const d = disclosure();
    assert.equal(d.text, LINE);
    assert.equal(withoutFoldedAiDisclosure(applyAiDisclosure('Die Abstimmung läuft.', { disclosure: d }).text, d), 'Die Abstimmung läuft.');
    assert.equal(withoutFoldedAiDisclosure(applyAiDisclosure('', { disclosure: d }).text, d), '');
    const withNote = disclosure({ operatorNote: 'Fragen an it@example.org.' });
    assert.equal(withoutFoldedAiDisclosure(applyAiDisclosure('Ok.', { disclosure: withNote }).text, withNote), 'Ok.');
    // Not folded this turn (a later turn of the scope), or no disclosure at all.
    assert.equal(withoutFoldedAiDisclosure('Die Abstimmung läuft.', d), 'Die Abstimmung läuft.');
    assert.equal(withoutFoldedAiDisclosure(`Ok.\n\n${LINE}`, undefined), `Ok.\n\n${LINE}`);
    // The sentence in the middle of a text is the model's own words.
    assert.equal(withoutFoldedAiDisclosure(`${LINE}\n\nUnd weiter.`, d), `${LINE}\n\nUnd weiter.`);
  });
});

describe('own-identity sends: the AI marking', () => {
  let supports: SendProviderCapabilities;
  let outcome: TargetedDeliveryOutcome;
  let posted: TargetedMessage[];
  let level: AiDisclosure | undefined;
  let post: (text: string, conversationId?: string) => Promise<TargetedDeliveryOutcome>;
  let dm: (text: string) => Promise<unknown>;

  beforeEach(async () => {
    supports = { asChannelKey: true };
    outcome = { outcome: 'delivered', messageId: 'm1' };
    posted = [];
    level = disclosure();
    const f = hubFixture(new InMemoryConversationMessageStore());
    await readAll(f, 'mara');
    const ownIdentity = {
      identityFor: (slug: string) => (slug === 'mara' ? { channelKey: MARA_KEY } : undefined),
      subscriptions: f.hub,
      getRoster: () =>
        Promise.resolve({
          conversationType: 'group' as const,
          partial: false,
          participants: [{ userRef: { kind: 'teams-aad' as const, id: ANNA, displayName: 'Anna' } }],
        }),
      disclosure: {
        disclosureFor: (slug: string, channelType: string) => (slug === 'mara' && channelType === 'teams' ? level : undefined),
        seen: new InMemoryDisclosureSeenStore(),
      },
    };
    const conversations = new ConversationSendRegistry();
    conversations.register('@omadia/channel-teams', {
      channelType: 'teams',
      get supports() {
        return supports;
      },
      sendToConversation: (_id, message) => {
        posted.push(message);
        return Promise.resolve(outcome);
      },
    });
    const users = new TargetedSendRegistry();
    users.register('@omadia/channel-teams', {
      channelType: 'teams',
      get supports() {
        return supports;
      },
      sendToUser: (_target, message) => {
        posted.push(message);
        return Promise.resolve(outcome);
      },
    });
    const conversationSend = createConversationSendService({ providers: conversations, ownIdentity });
    const targetedSend = createTargetedDeliveryService({
      providers: users,
      lookupConversationRefs: () => Promise.resolve(new Map()),
      ownIdentity,
    });
    post = (text, conversationId = CONVERSATION) =>
      conversationSend.sendToConversation(
        { agentSlug: 'mara', channelType: 'teams', conversationId, message: { text } },
        // What `conversationSend@2` hands in once the scope authorized the post.
        { subscriptions: f.hub.subscriptionsOfProcess(ENGINE, processOf('mara').processId, 'mara') },
      );
    dm = (text) =>
      targetedSend.sendToPrincipal(
        { channelType: 'teams', principal: `user:${ANNA}`, message: { text }, asAgentSlug: 'mara' } as never,
        ENGINE,
      );
  });

  it('a channel with its own AI label gets the text as it is: the label marks it, no sentence', async () => {
    supports = { asChannelKey: true, aiLabel: true };
    await post('Willkommen.');
    await post('Die Abstimmung ist offen.');
    await dm('Ein Schritt ist noch offen.');
    assert.deepEqual(posted.map((m) => m.text), ['Willkommen.', 'Die Abstimmung ist offen.', 'Ein Schritt ist noch offen.']);
  });

  it('a channel without a label gets the instance sentence on the first post of a conversation, once', async () => {
    await post('Willkommen.');
    await post('Die Abstimmung ist offen.');
    assert.deepEqual(posted.map((m) => m.text), [`Willkommen.\n\n${LINE}`, 'Die Abstimmung ist offen.']);
  });

  it('a direct message is its own conversation: marked once as well', async () => {
    await post('Willkommen.');
    await dm('Ein Schritt ist noch offen.');
    await dm('Erinnerung.');
    assert.deepEqual(posted.map((m) => m.text), [
      `Willkommen.\n\n${LINE}`,
      `Ein Schritt ist noch offen.\n\n${LINE}`,
      'Erinnerung.',
    ]);
  });

  it('a post the channel refused does not use up the marking', async () => {
    outcome = { outcome: 'unreachable', code: 'channel_error', message: 'throttled' };
    await post('Willkommen.');
    outcome = { outcome: 'delivered', messageId: 'm2' };
    await post('Willkommen.');
    assert.deepEqual(posted.map((m) => m.text), [`Willkommen.\n\n${LINE}`, `Willkommen.\n\n${LINE}`]);
    await post('Weiter.');
    assert.equal(posted[2]?.text, 'Weiter.');
  });

  it('the operator turned the disclosure off: no sentence', async () => {
    level = undefined;
    await post('Willkommen.');
    assert.deepEqual(posted.map((m) => m.text), ['Willkommen.']);
  });

  it('a throwing policy lookup blocks no send and marks with the shipping default', () => {
    const marked = markOwnIdentityMessage(
      {
        disclosureFor: () => {
          throw new Error('registry gone');
        },
        seen: new InMemoryDisclosureSeenStore(),
      },
      { agentSlug: 'mara', channelType: 'teams', target: CONVERSATION },
      { text: 'Hi.' },
      { asChannelKey: true },
    );
    assert.equal(marked.message.text, 'Hi.\n\nDiese Antwort wurde von einem KI-System erzeugt.');
  });
});
