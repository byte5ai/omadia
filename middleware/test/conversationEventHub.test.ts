import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ConversationMembershipEvent } from '@omadia/channel-sdk';

import { ConversationEventHub } from '../src/channels/conversationEventHub.js';

// #330 B2 seam — membership-event fan-out with per-subscriber isolation.

const BOT_ADDED: ConversationMembershipEvent = {
  kind: 'bot_added',
  channelId: 'de.byte5.channel.teams',
  channelType: 'teams',
  conversationId: 'conv-1',
  conversationType: 'group',
  members: [{ kind: 'teams-aad', id: 'bot-1' }],
  addedBy: { kind: 'teams-aad', id: 'owner-1' },
  occurredAt: '2026-08-21T10:00:00.000Z',
};

describe('ConversationEventHub', () => {
  it('emitting with no subscriber is a logged no-op', () => {
    const logs: string[] = [];
    const hub = new ConversationEventHub((msg) => logs.push(msg));
    hub.emit(BOT_ADDED);
    assert.ok(logs.some((l) => l.includes('bot_added')));
  });

  it('fans out to every subscriber and transports addedBy unchanged', () => {
    const hub = new ConversationEventHub();
    const seen: ConversationMembershipEvent[] = [];
    hub.subscribe((e) => seen.push(e));
    hub.subscribe((e) => seen.push(e));

    hub.emit(BOT_ADDED);
    assert.equal(seen.length, 2);
    const first = seen[0]!;
    assert.equal(first.kind, 'bot_added');
    assert.deepEqual(first.kind === 'bot_added' ? first.addedBy : undefined, { kind: 'teams-aad', id: 'owner-1' });
  });

  it('a throwing subscriber is isolated — siblings still receive the event', () => {
    const logs: string[] = [];
    const hub = new ConversationEventHub((msg) => logs.push(msg));
    const seen: string[] = [];
    hub.subscribe(() => {
      throw new Error('bad subscriber');
    });
    hub.subscribe((e) => seen.push(e.kind));

    hub.emit(BOT_ADDED);
    assert.deepEqual(seen, ['bot_added']);
    assert.ok(logs.some((l) => l.includes('subscriber threw')));
  });

  it('unsubscribe stops delivery', () => {
    const hub = new ConversationEventHub();
    const seen: string[] = [];
    const unsubscribe = hub.subscribe((e) => seen.push(e.kind));
    unsubscribe();
    hub.emit(BOT_ADDED);
    assert.deepEqual(seen, []);
  });
});
