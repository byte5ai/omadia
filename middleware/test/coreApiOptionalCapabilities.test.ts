import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ChatStreamEvent, ConversationRosterProvider, TargetedSendProvider } from '@omadia/channel-sdk';

import { createCoreApi } from '../src/channels/coreApi.js';
import type { CreateCoreApiOptions } from '../src/channels/coreApi.js';
import { ConversationRosterRegistry } from '../src/channels/rosterRegistry.js';
import { ConversationEventHub } from '../src/channels/conversationEventHub.js';
import { TargetedSendRegistry } from '../src/channels/targetedSendRegistry.js';

// #330 B1 — the additivity contract: without the new registries the three new
// CoreApi methods are simply NOT defined (the registerWebSocket pattern), so
// an old kernel wiring and an old plugin against a new kernel both stay
// byte-for-byte on today's behaviour.

function baseOptions(): CreateCoreApiOptions {
  return {
    dispatcher: {
      streamTurn(): AsyncIterable<ChatStreamEvent> {
        return (async function* () {})();
      },
    },
    routes: {
      register: () => undefined,
      registerRouter: () => undefined,
    } as unknown as CreateCoreApiOptions['routes'],
    log: () => undefined,
  };
}

describe('createCoreApi — #330 optional group capabilities', () => {
  it('without the registries the new methods are undefined (feature-detect holds)', () => {
    const api = createCoreApi(baseOptions());
    assert.equal(api.registerRosterProvider, undefined);
    assert.equal(api.registerTargetedSendProvider, undefined);
    assert.equal(api.emitConversationEvent, undefined);
    // The pre-existing optional capability behaves identically.
    assert.equal(api.registerWebSocket, undefined);
  });

  it('with the registries, registration round-trips into them', async () => {
    const rosterRegistry = new ConversationRosterRegistry();
    const targetedSends = new TargetedSendRegistry();
    const conversationEvents = new ConversationEventHub();
    const api = createCoreApi({ ...baseOptions(), rosterRegistry, targetedSends, conversationEvents });

    const roster: ConversationRosterProvider = {
      channelType: 'teams',
      getRoster: async () => ({ conversationType: 'group', participants: [], partial: false }),
    };
    api.registerRosterProvider?.('plugin-teams', roster);
    assert.deepEqual(rosterRegistry.types(), ['teams']);
    assert.deepEqual(await rosterRegistry.getRoster('teams', 'c1'), {
      conversationType: 'group',
      participants: [],
      partial: false,
    });

    const sender: TargetedSendProvider = {
      channelType: 'teams',
      sendToUser: async () => ({ outcome: 'delivered' }),
    };
    api.registerTargetedSendProvider?.('plugin-teams', sender);
    assert.equal(targetedSends.get('teams'), sender);

    const kinds: string[] = [];
    conversationEvents.subscribe((e) => kinds.push(e.kind));
    api.emitConversationEvent?.({
      kind: 'members_added',
      channelId: 'de.byte5.channel.teams',
      conversationId: 'c1',
      members: [],
      occurredAt: '2026-08-21T10:00:00.000Z',
    });
    assert.deepEqual(kinds, ['members_added']);
  });
});
