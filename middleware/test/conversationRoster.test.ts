import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { isGroupConversation } from '@omadia/channel-sdk';
import type { ConversationRoster, ConversationRosterProvider } from '@omadia/channel-sdk';

import { ConversationRosterRegistry } from '../src/channels/rosterRegistry.js';

// #330 B1 — conversationType semantics + the kernel roster registry.

describe('isGroupConversation', () => {
  it("is true only for an explicit 'group' — absent means unknown, treated as direct", () => {
    assert.equal(isGroupConversation({ conversationType: 'group' }), true);
    assert.equal(isGroupConversation({ conversationType: 'direct' }), false);
    assert.equal(isGroupConversation({}), false);
  });
});

const ROSTER: ConversationRoster = {
  conversationType: 'group',
  participants: [{ userRef: { kind: 'teams-aad', id: 'u1' } }, { userRef: { kind: 'teams-aad', id: 'u2' } }],
  partial: false,
};

function provider(channelType: string, impl?: ConversationRosterProvider['getRoster']): ConversationRosterProvider {
  return { channelType, getRoster: impl ?? (async () => ROSTER) };
}

describe('ConversationRosterRegistry', () => {
  it('serves the registered provider per channel type and replaces on re-register', async () => {
    const registry = new ConversationRosterRegistry();
    registry.register('plugin-a', provider('teams'));
    assert.deepEqual(await registry.getRoster('teams', 'conv-1'), ROSTER);

    const replacement: ConversationRoster = { conversationType: 'direct', participants: [], partial: false };
    registry.register('plugin-a', provider('teams', async () => replacement));
    assert.deepEqual(await registry.getRoster('teams', 'conv-1'), replacement);
    assert.deepEqual(registry.types(), ['teams']);
  });

  it('returns undefined for an unserved channel type', async () => {
    const registry = new ConversationRosterRegistry();
    assert.equal(await registry.getRoster('telegram', 'conv-1'), undefined);
  });

  it('unregisterChannel drops exactly that channel plugin\'s contributions', async () => {
    const registry = new ConversationRosterRegistry();
    registry.register('plugin-a', provider('teams'));
    registry.register('plugin-b', provider('telegram'));

    registry.unregisterChannel('plugin-a');
    assert.equal(await registry.getRoster('teams', 'conv-1'), undefined);
    assert.deepEqual(await registry.getRoster('telegram', 'conv-1'), ROSTER);
    registry.unregisterChannel('plugin-a'); // idempotent
  });

  it('rejects a FOREIGN replace — first registrant owns the channel type (no roster hijack)', async () => {
    const registry = new ConversationRosterRegistry();
    registry.register('plugin-a', provider('teams'));
    assert.throws(
      () => registry.register('plugin-b', provider('teams')),
      /already owned by channel 'plugin-a'/,
    );
    // The owner's provider is untouched.
    assert.deepEqual(await registry.getRoster('teams', 'conv-1'), ROSTER);
  });

  it('isolates a throwing provider — roster degrades to unknown, no crash', async () => {
    const logs: string[] = [];
    const registry = new ConversationRosterRegistry((msg) => logs.push(msg));
    registry.register('plugin-a', provider('teams', async () => {
      throw new Error('graph offline');
    }));

    assert.equal(await registry.getRoster('teams', 'conv-1'), undefined);
    assert.ok(logs.some((l) => l.includes('FAILED')));
  });
});
