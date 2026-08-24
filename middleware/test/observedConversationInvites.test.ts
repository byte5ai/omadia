import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConversationMembershipEvent } from '@omadia/channel-sdk';

import { ConversationEventHub } from '../src/channels/conversationEventHub.js';
import { ObservedConversationInvites } from '../src/platform/observedConversationInvites.js';
import type { ObservedInvite } from '../src/platform/observedConversationInvites.js';

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

  it("records 'bot_present' (#330 round 3) as eligibility — group-only, like bot_added", () => {
    const invites = new ObservedConversationInvites();
    invites.observe(botAdded({ kind: 'bot_present', conversationId: 'grp-present' }));
    assert.equal(invites.get('teams', 'grp-present')?.addedBy?.id, 'aad-owner');
    invites.observe(botAdded({ kind: 'bot_present', conversationId: 'dm-present', conversationType: 'direct' }));
    assert.equal(invites.get('teams', 'dm-present'), undefined);
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

// #330 follow-up — the index survives restarts via a write-through backing
// store. Losing the store degrades to the old re-invite behaviour; it must
// never break the live event path.
describe('ObservedConversationInvites persistence', () => {
  function fakePersistence(seed: Array<{ invite: ObservedInvite; seenAt: number }> = []) {
    const rows = new Map(seed.map((r) => [`${r.invite.channelType}::${r.invite.conversationId}`, r]));
    return {
      upserts: [] as string[],
      deletes: [] as string[],
      store: rows,
      async upsert(invite: ObservedInvite, seenAt: number) {
        this.upserts.push(invite.conversationId);
        rows.set(`${invite.channelType}::${invite.conversationId}`, { invite, seenAt });
      },
      async delete(channelType: string, conversationId: string) {
        this.deletes.push(conversationId);
        rows.delete(`${channelType}::${conversationId}`);
      },
      async loadFresh(minSeenAtMs: number) {
        return [...rows.entries()]
          .filter(([, r]) => r.seenAt >= minSeenAtMs)
          .map(([key, r]) => {
            const [channelType, conversationId] = key.split('::') as [string, string];
            return { channelType, conversationId, invite: r.invite, seenAt: r.seenAt };
          });
      },
    };
  }

  function persistedInvite(conversationId: string, seenAt: number): { invite: ObservedInvite; seenAt: number } {
    return {
      invite: { channelId: 'de.byte5.channel.teams', channelType: 'teams', conversationId, occurredAt: '2026-08-21T09:00:00.000Z' },
      seenAt,
    };
  }

  it('writes observed invites through and removes expired ones from the store', async () => {
    let now = 1_000_000;
    const persistence = fakePersistence();
    const invites = new ObservedConversationInvites({ ttlMs: 60_000, now: () => now });
    invites.attachPersistence(persistence);
    invites.observe(botAdded());
    await Promise.resolve();
    assert.deepEqual(persistence.upserts, ['conv-1']);

    now += 61_000;
    assert.equal(invites.get('teams', 'conv-1'), undefined);
    await Promise.resolve();
    assert.deepEqual(persistence.deletes, ['conv-1']);
  });

  it('hydrates TTL-fresh rows at boot; stale rows and live observations are respected', async () => {
    const now = 1_000_000;
    const persistence = fakePersistence([
      persistedInvite('conv-restored', now - 30_000),
      persistedInvite('conv-stale', now - 61_000),
      { ...persistedInvite('conv-live', now - 30_000), invite: { ...persistedInvite('conv-live', 0).invite, channelId: 'persisted-old' } },
    ]);
    const invites = new ObservedConversationInvites({ ttlMs: 60_000, now: () => now });
    invites.attachPersistence(persistence);
    // A live event lands BEFORE hydration (boot race) — it must win.
    invites.observe(botAdded({ conversationId: 'conv-live' }));
    await invites.hydrate();

    assert.ok(invites.get('teams', 'conv-restored'), 'fresh persisted invite restored');
    assert.equal(invites.get('teams', 'conv-stale'), undefined);
    assert.equal(invites.get('teams', 'conv-live')?.channelId, 'de.byte5.channel.teams');
  });

  it('a restored invite authorises exactly like a live one (restart survival)', async () => {
    const now = 1_000_000;
    const persistence = fakePersistence();
    const before = new ObservedConversationInvites({ ttlMs: 60_000, now: () => now });
    before.attachPersistence(persistence);
    before.observe(botAdded());
    await Promise.resolve();

    // "Restart": a brand-new index over the same backing store.
    const after = new ObservedConversationInvites({ ttlMs: 60_000, now: () => now });
    after.attachPersistence(persistence);
    await after.hydrate();
    assert.equal(after.get('teams', 'conv-1')?.addedBy?.id, 'aad-owner');
  });

  it('drops hydrated rows whose payload disagrees with their key columns (scope-guard hardening)', async () => {
    const persistence = fakePersistence();
    // A tampered row: key columns say conv-columns, JSONB names conv-other.
    persistence.store.set('teams::conv-columns', persistedInvite('conv-other', 1_000_000));
    const invites = new ObservedConversationInvites({ ttlMs: 60_000, now: () => 1_000_000 });
    invites.attachPersistence(persistence);
    await invites.hydrate();
    assert.equal(invites.get('teams', 'conv-columns'), undefined);
    assert.equal(invites.get('teams', 'conv-other'), undefined);
  });
});
