import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConversationSendProvider } from '@omadia/channel-sdk';

import { ConversationSendRegistry } from '../src/channels/conversationSendRegistry.js';
import { createConversationSendService } from '../src/channels/conversationSendService.js';

// #330 C3b — conversation-addressed proactive send (group nudges): named
// outcomes, never a throw; first-registrant ownership like every provider
// registry in this kernel.

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

  const permitAll = async () => true;

  it('delivers into the conversation via the registered provider (scope-permitted)', async () => {
    const sent: string[] = [];
    const providers = new ConversationSendRegistry();
    providers.register('plugin-teams', provider(sent));
    const service = createConversationSendService({ providers, isPermitted: permitAll });

    const out = await service.sendToConversation({ agentSlug: 'facilitator', channelType: 'teams', conversationId: 'conv-1', message: { text: 'nudge' } });
    assert.deepEqual(out, { outcome: 'delivered' });
    assert.deepEqual(sent, ['conv-1:nudge']);
  });

  it('H1 — scope guard: unpermitted conversations and a missing scope authority FAIL CLOSED', async () => {
    const sent: string[] = [];
    const providers = new ConversationSendRegistry();
    providers.register('plugin-teams', provider(sent));

    const scoped = createConversationSendService({
      providers,
      isPermitted: async (agentSlug, _type, conversationId) => agentSlug === 'facilitator' && conversationId === 'mine',
      log: () => undefined,
    });
    const foreign = await scoped.sendToConversation({ agentSlug: 'facilitator', channelType: 'teams', conversationId: 'not-mine', message: { text: 'x' } });
    assert.equal(foreign.outcome === 'unreachable' ? foreign.code : '', 'not_permitted');

    const noAuthority = createConversationSendService({ providers, log: () => undefined });
    const closed = await noAuthority.sendToConversation({ agentSlug: 'facilitator', channelType: 'teams', conversationId: 'mine', message: { text: 'x' } });
    assert.equal(closed.outcome === 'unreachable' ? closed.code : '', 'not_permitted');
    assert.deepEqual(sent, [], 'nothing may be delivered without a positive scope decision');
  });

  it('unknown channel type and a throwing provider both become named unreachable outcomes', async () => {
    const providers = new ConversationSendRegistry();
    const service = createConversationSendService({ providers, isPermitted: permitAll, log: () => undefined });
    const missing = await service.sendToConversation({ agentSlug: 'a', channelType: 'telegram', conversationId: 'c', message: { text: 'x' } });
    assert.equal(missing.outcome, 'unreachable');

    providers.register('plugin-teams', {
      channelType: 'teams',
      sendToConversation: async () => {
        throw new Error('BF outage');
      },
    });
    const threw = await service.sendToConversation({ agentSlug: 'a', channelType: 'teams', conversationId: 'c', message: { text: 'x' } });
    assert.equal(threw.outcome === 'unreachable' ? threw.message : '', 'BF outage');
  });

  it('rejects a foreign replace — first registrant owns the channel type', () => {
    const providers = new ConversationSendRegistry();
    providers.register('plugin-a', provider([]));
    assert.throws(() => providers.register('plugin-b', provider([])), /already owned by channel 'plugin-a'/);
    providers.unregisterChannel('plugin-a');
    assert.equal(providers.get('teams'), undefined);
  });
});
