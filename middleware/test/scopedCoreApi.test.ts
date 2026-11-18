/**
 * #2043 — a channel plugin gets a CoreApi bound to itself: what it emits
 * carries its own id, and it cannot emit or register for a channel type it
 * does not serve. The message record and the presence signal are only as
 * trustworthy as this binding.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { CoreApi } from '@omadia/channel-sdk';

import { ConversationEventHub } from '../src/channels/conversationEventHub.js';
import { createCoreApi } from '../src/channels/coreApi.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { scopeCoreApiToChannel } from '../src/channels/scopedCoreApi.js';
import { ChannelProviderRegistry } from '../src/channels/sessionCapabilities/providerRegistry.js';
import {
  CONVERSATION,
  ENGINE,
  hubFixture,
  MARA_KEY,
  messageEvent,
  scopeOf,
} from './_helpers/conversationMessagesFixture.js';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('CoreApi scoped to one channel plugin', () => {
  async function setup() {
    const messages = hubFixture(new InMemoryConversationMessageStore());
    await messages.hub.subscribe(scopeOf('mara'), ENGINE);
    const events = new ConversationEventHub();
    const membership: { channelId: string; channelType?: string; kind: string }[] = [];
    events.subscribe((e) => void membership.push({ channelId: e.channelId, kind: e.kind, ...(e.channelType ? { channelType: e.channelType } : {}) }));
    const readiness = new ChannelProviderRegistry<never>('readiness');
    const sessionEvents: unknown[] = [];
    const core = createCoreApi({
      dispatcher: {} as never,
      routes: {} as never,
      conversationEvents: events,
      conversationMessages: messages.hub,
      readinessProviders: readiness as never,
      meetingSources: new ChannelProviderRegistry<never>('meetingSource') as never,
      sessionCapabilities: {
        emitSnapshot: (s) => void sessionEvents.push(['snapshot', s.channelType]),
        emitSessionEvent: (e) => void sessionEvents.push(['event', e.channelId, e.channelType]),
      },
    });
    const logs: string[] = [];
    const teams: CoreApi = scopeCoreApiToChannel(core, '@omadia/channel-teams', 'teams', (m) => logs.push(m));
    const rogue: CoreApi = scopeCoreApiToChannel(core, '@acme/channel-slack', 'slack', (m) => logs.push(m));
    return { messages, membership, readiness, sessionEvents, logs, teams, rogue };
  }

  it('another channel plugin cannot emit a message event for a channel type it does not serve', async () => {
    const s = await setup();
    // A Slack channel plugin forging a Teams vote from Anna.
    s.rogue.emitConversationMessage!(messageEvent({ channelId: '@omadia/channel-teams', messageId: 'forged' }));
    await flush();
    assert.deepEqual((await s.messages.hub.listSince(scopeOf('mara'), ENGINE)).events, []);
    assert.match(s.logs[0]!, /@acme\/channel-slack tried to emit a message event for channel type 'teams'; it serves 'slack'/);

    s.teams.emitConversationMessage!(messageEvent({ channelId: 'whatever-it-claims', messageId: 'real' }));
    await flush();
    assert.deepEqual(
      (await s.messages.hub.listSince(scopeOf('mara'), ENGINE)).events.map((e) => e.messageId),
      ['real'],
    );
  });

  it('nor learn which Teams conversations are subscribed', async () => {
    const s = await setup();
    assert.equal(s.teams.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY), true);
    assert.equal(s.rogue.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY), false);
  });

  it('membership and session events carry the emitting plugin and its own channel type', async () => {
    const s = await setup();
    const added = {
      kind: 'bot_added' as const,
      channelId: 'spoofed-id',
      conversationId: CONVERSATION,
      conversationType: 'group' as const,
      members: [],
      occurredAt: '2026-11-18T09:00:00Z',
    };
    s.teams.emitConversationEvent!(added);
    // The presence signal behind `subscribe`: not forgeable for Teams by Slack.
    s.rogue.emitConversationEvent!({ ...added, channelType: 'teams' });
    s.rogue.emitConversationEvent!(added);
    assert.deepEqual(s.membership, [
      { channelId: '@omadia/channel-teams', kind: 'bot_added', channelType: 'teams' },
      { channelId: '@acme/channel-slack', kind: 'bot_added', channelType: 'slack' },
    ]);
    const session = {
      channelId: 'spoofed-id',
      channelType: 'teams',
      conversationId: CONVERSATION,
      sessionRef: 'm',
      kind: 'session_started' as const,
      occurredAt: '2026-11-18T10:00:00Z',
    };
    s.teams.emitSessionEvent!(session);
    s.rogue.emitSessionEvent!(session);
    s.rogue.emitSessionCapabilities!({ channelType: 'teams', conversationId: CONVERSATION, modality: 'online', inputs: [], outputs: [], capturedAt: 'x' });
    assert.deepEqual(s.sessionEvents, [['event', '@omadia/channel-teams', 'teams']]);
  });

  it('a readiness provider or meeting source can only be registered for the own channel type, under the own id', async () => {
    const s = await setup();
    const provider = { channelType: 'teams', check: () => Promise.resolve({} as never) };
    assert.throws(
      () => s.rogue.registerReadinessProvider!('@omadia/channel-teams', provider),
      /serves 'slack' and cannot register a readiness provider for 'teams'/,
    );
    assert.throws(
      () => s.rogue.registerMeetingSourceProvider!('x', { channelType: 'teams', snapshot: () => Promise.resolve(undefined) }),
      /cannot register a meeting source for 'teams'/,
    );
    assert.deepEqual(s.readiness.types(), []);
    s.teams.registerReadinessProvider!('someone-else', provider);
    assert.deepEqual(s.readiness.types(), ['teams']);
    // Owned by the real plugin id, so that plugin's deactivation drops it.
    s.readiness.unregisterChannel('someone-else');
    assert.deepEqual(s.readiness.types(), ['teams']);
    s.readiness.unregisterChannel('@omadia/channel-teams');
    assert.deepEqual(s.readiness.types(), []);
  });

  it('everything else of CoreApi is the shared object', async () => {
    const s = await setup();
    const core = createCoreApi({ dispatcher: {} as never, routes: {} as never });
    const scoped = scopeCoreApiToChannel(core, 'c', 'teams');
    assert.equal(scoped.handleTurn, core.handleTurn);
    assert.equal(scoped.registerRoute, core.registerRoute);
    assert.equal(scoped.emitConversationMessage, undefined, 'still feature-detectable');
    assert.ok(s.teams.emitConversationMessage);
  });
});
