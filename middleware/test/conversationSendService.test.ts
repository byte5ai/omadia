import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConversationSendProvider } from '@omadia/channel-sdk';

import { ConversationSendRegistry } from '../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../src/channels/conversationSendService.js';

// Conversation-addressed proactive send: named outcomes, never a throw;
// first-registrant ownership like every provider registry in this kernel.
// The only scope is the agent's own identity (#2043); what that scope does is
// pinned in `ownIdentitySend.test.ts`. This file pins what is refused.

describe('conversationSend', () => {
  function provider(sent: string[]): ConversationSendProvider {
    return {
      channelType: 'teams',
      sendToConversation: async (conversationId, message) => {
        sent.push(`${conversationId}:${message.text}`);
        return { outcome: 'delivered' };
      },
    };
  }

  it('refuses a send that is not as the agent own identity (the plugin-era attachment scope is gone)', async () => {
    const sent: string[] = [];
    const providers = new ConversationSendRegistry();
    providers.register('plugin-teams', provider(sent));
    const service = createConversationSendService({
      providers,
      ownIdentity: { identityFor: () => ({ channelKey: '28:bot' }) },
      log: () => undefined,
    });
    for (const asOwnIdentity of [undefined, false]) {
      const out = await service.sendToConversation({
        agentSlug: 'facilitator',
        channelType: 'teams',
        conversationId: 'conv-1',
        message: { text: 'nudge' },
        ...(asOwnIdentity === undefined ? {} : { asOwnIdentity }),
      });
      assert.equal(out.outcome === 'unreachable' ? out.code : '', 'not_permitted');
      assert.match(out.outcome === 'unreachable' ? out.message : '', /own identity only: set asOwnIdentity/);
    }
    const anonymous = await service.sendToConversation({
      agentSlug: ' ',
      channelType: 'teams',
      conversationId: 'conv-1',
      message: { text: 'x' },
      asOwnIdentity: true,
    });
    assert.equal(anonymous.outcome === 'unreachable' ? anonymous.message : '', 'agentSlug is required');
    assert.deepEqual(sent, [], 'nothing reaches a channel');
  });

  it('without own-identity wiring (no registry, no database) every send fails closed', async () => {
    const sent: string[] = [];
    const providers = new ConversationSendRegistry();
    providers.register('plugin-teams', provider(sent));
    const bare = createConversationSendService({ providers, log: () => undefined });
    const noIdentity = await bare.sendToConversation({
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: 'c',
      message: { text: 'x' },
      asOwnIdentity: true,
    });
    assert.equal(noIdentity.outcome === 'unreachable' ? noIdentity.code : '', 'no_identity');
    // An identity but no subscription authority: not permitted.
    const noSubscriptions = createConversationSendService({
      providers,
      ownIdentity: { identityFor: () => ({ channelKey: '28:bot' }) },
      log: () => undefined,
    });
    const closed = await noSubscriptions.sendToConversation({
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: 'c',
      message: { text: 'x' },
      asOwnIdentity: true,
    });
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
