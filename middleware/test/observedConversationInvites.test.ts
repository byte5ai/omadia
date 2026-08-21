import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConversationMembershipEvent } from '@omadia/channel-sdk';

import { ConversationEventHub } from '../src/channels/conversationEventHub.js';
import { ObservedConversationInvites } from '../src/platform/observedConversationInvites.js';

// #330 C2a — the auto-bind scope guard's data source. Only kernel-observed
// GROUP bot_added events count; everything else must never make a
// conversation bindable.

function botAdded(overrides: Partial<ConversationMembershipEvent> = {}): ConversationMembershipEvent {
  return {
    kind: 'bot_added',
    channelId: 'de.byte5.channel.teams',
    channelType: 'teams',
    conversationId: 'conv-1',
    conversationType: 'group',
    members: [{ kind: 'teams-aad', id: 'bot' }],
    addedBy: { kind: 'teams-aad', id: 'aad-owner', displayName: 'Owner' },
    occurredAt: '2026-08-21T10:00:00.000Z',
    ...overrides,
  } as ConversationMembershipEvent;
}

describe('ObservedConversationInvites', () => {
  it('records a group bot_added (via the hub) with the inviter', () => {
    const hub = new ConversationEventHub();
    const invites = new ObservedConversationInvites();
    invites.attach(hub);
    hub.emit(botAdded());

    const invite = invites.get('teams', 'conv-1');
    assert.equal(invite?.channelType, 'teams');
    assert.equal(invite?.addedBy?.id, 'aad-owner');
  });

  it('ignores 1:1, unknown-type and non-invite events — no positive statement, no eligibility', () => {
    const invites = new ObservedConversationInvites();
    invites.observe(botAdded({ conversationType: 'direct', conversationId: 'dm-1' }));
    const noConvType = botAdded({ conversationId: 'unknown-1' });
    delete (noConvType as { conversationType?: string }).conversationType;
    invites.observe(noConvType);
    const noChannelType = botAdded({ conversationId: 'nochan-1' });
    delete (noChannelType as { channelType?: string }).channelType;
    invites.observe(noChannelType);
    invites.observe(botAdded({ kind: 'members_added', conversationId: 'grp-2' }));

    assert.equal(invites.get('teams', 'dm-1'), undefined);
    assert.equal(invites.get('teams', 'unknown-1'), undefined);
    assert.equal(invites.get('teams', 'grp-2'), undefined);
    assert.equal(invites.get('teams', 'nochan-1'), undefined);
  });

  it('expires invites after the TTL', () => {
    let now = 1_000_000;
    const invites = new ObservedConversationInvites({ ttlMs: 60_000, now: () => now });
    invites.observe(botAdded());
    assert.ok(invites.get('teams', 'conv-1'));
    now += 61_000;
    assert.equal(invites.get('teams', 'conv-1'), undefined);
  });
});
