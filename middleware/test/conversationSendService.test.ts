import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConversationSendProvider } from '@omadia/channel-sdk';

import { ConversationSendRegistry } from '../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../src/channels/conversationSendService.js';

// Posting into a conversation as an agent's own identity: named outcomes,
// never a throw; first-registrant ownership like every provider registry in
// this kernel. What a permitted post does is pinned in
// `ownIdentitySend.test.ts`, its authorization in `scopedSendService.test.ts`.
// This file pins what is refused before anything reaches a channel.

describe('conversationSend', () => {
  function provider(sent: string[]): ConversationSendProvider {
    return {
      channelType: 'teams',
      supports: { asChannelKey: true },
      sendToConversation: async (conversationId, message) => {
        sent.push(`${conversationId}:${message.text}`);
        return { outcome: 'delivered' };
      },
    };
  }
  const GROUND = { subscriptions: [] };

  it('posts nothing without an agent, and nothing without the ground an authorization leaves', async () => {
    const sent: string[] = [];
    const providers = new ConversationSendRegistry();
    providers.register('plugin-teams', provider(sent));
    const logs: string[] = [];
    const service = createConversationSendService({
      providers,
      ownIdentity: { identityFor: () => ({ channelKey: '28:bot' }) },
      log: (m) => logs.push(m),
    });
    const input = { agentSlug: 'mara', channelType: 'teams', conversationId: 'conv-1', message: { text: 'nudge' } };
    const anonymous = await service.sendToConversation({ ...input, agentSlug: ' ' }, GROUND);
    assert.equal(anonymous.outcome === 'unreachable' ? anonymous.message : '', 'agentSlug is required');
    // The type requires the ground; a caller that comes without it has no
    // authorization (there is no other permission to fall back to).
    const unauthorized = await service.sendToConversation(input, undefined as never);
    assert.equal(unauthorized.outcome === 'unreachable' ? unauthorized.code : '', 'not_permitted');
    assert.match(unauthorized.outcome === 'unreachable' ? unauthorized.message : '', /only under an execution scope/);
    const card = await service.updateCard(
      { ...input, cardMessageId: 'card-1', update: { state: 'closed' } },
      undefined as never,
    );
    assert.equal(card.outcome === 'unreachable' ? card.code : '', 'not_permitted');
    assert.deepEqual(sent, [], 'nothing reaches a channel');
    assert.ok(logs.some((l) => /refused \(no authorization\)/.test(l)));
    // With the ground, the same input is posted.
    assert.deepEqual(await service.sendToConversation(input, GROUND), { outcome: 'delivered' });
    assert.deepEqual(sent, ['conv-1:nudge']);
  });

  it('without own-identity wiring (no registry, no database) every send fails closed', async () => {
    const sent: string[] = [];
    const providers = new ConversationSendRegistry();
    providers.register('plugin-teams', provider(sent));
    const bare = createConversationSendService({ providers, log: () => undefined });
    const noIdentity = await bare.sendToConversation(
      { agentSlug: 'mara', channelType: 'teams', conversationId: 'c', message: { text: 'x' } },
      GROUND,
    );
    assert.equal(noIdentity.outcome === 'unreachable' ? noIdentity.code : '', 'no_identity');
    // An agent whose archetype does not add posting as itself: not permitted,
    // whatever was authorized.
    const notAdded = createConversationSendService({
      providers,
      ownIdentity: { identityFor: () => ({ channelKey: '28:bot' }), archetypeAddsOwnIdentitySend: () => false },
      log: () => undefined,
    });
    const closed = await notAdded.sendToConversation(
      { agentSlug: 'hr', channelType: 'teams', conversationId: 'c', message: { text: 'x' } },
      GROUND,
    );
    assert.equal(closed.outcome === 'unreachable' ? closed.code : '', 'not_permitted');
    assert.deepEqual(sent, []);
  });

  it('rejects a foreign replace — first registrant owns the channel type', () => {
    const providers = new ConversationSendRegistry();
    providers.register('plugin-a', provider([]));
    assert.throws(() => providers.register('plugin-b', provider([])), /already owned by channel 'plugin-a'/);
    providers.unregisterChannel('plugin-a');
    assert.equal(providers.get('teams'), undefined);
  });
});
