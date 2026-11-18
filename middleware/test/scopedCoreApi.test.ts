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
import { ChannelTypeClaims, scopeCoreApiToChannel } from '../src/channels/scopedCoreApi.js';
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
    const claims = new ChannelTypeClaims();
    const teams: CoreApi = scopeCoreApiToChannel(core, '@omadia/channel-teams', claims, (m) => logs.push(m));
    const rogue: CoreApi = scopeCoreApiToChannel(core, '@acme/channel-slack', claims, (m) => logs.push(m));
    // What the real Teams plugin does while it activates: it registers its
    // providers, which is what makes `teams` its channel type. Its id-derived
    // type would be the id itself, so nothing may hang on that.
    teams.registerReadinessProvider!('@omadia/channel-teams', {
      channelType: 'teams',
      check: () => Promise.resolve({} as never),
    });
    rogue.emitConversationEvent!({
      kind: 'bot_present',
      channelId: 'x',
      channelType: 'slack',
      conversationId: 'c',
      conversationType: 'group',
      members: [],
      occurredAt: '2026-11-18T09:00:00Z',
    });
    membership.length = 0;
    return { messages, membership, readiness, sessionEvents, logs, claims, teams, rogue };
  }

  it('another channel plugin cannot emit a message event for a channel type it does not serve', async () => {
    const s = await setup();
    // A Slack channel plugin forging a Teams vote from Anna.
    s.rogue.emitConversationMessage!(messageEvent({ channelId: '@omadia/channel-teams', messageId: 'forged' }));
    await flush();
    assert.deepEqual((await s.messages.hub.listSince(scopeOf('mara'), ENGINE)).events, []);
    assert.match(
      s.logs[0]!,
      /@acme\/channel-slack tried to emit a message event for channel type 'teams', which belongs to @omadia\/channel-teams/,
    );

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
    s.teams.emitConversationEvent!({ ...added, channelType: 'teams' });
    s.rogue.emitConversationEvent!({ ...added, channelType: 'slack' });
    assert.deepEqual(s.membership, [
      // No channel type stated: passes with the real plugin id, as before.
      { channelId: '@omadia/channel-teams', kind: 'bot_added' },
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
      /cannot register a readiness provider for 'teams': the channel type belongs to '@omadia\/channel-teams'/,
    );
    assert.throws(
      () => s.rogue.registerMeetingSourceProvider!('x', { channelType: 'teams', snapshot: () => Promise.resolve(undefined) }),
      /cannot register a meeting source for 'teams'/,
    );
    s.teams.registerReadinessProvider!('someone-else', provider);
    assert.deepEqual(s.readiness.types(), ['teams']);
    // Owned by the real plugin id, so that plugin's deactivation drops it.
    s.readiness.unregisterChannel('someone-else');
    assert.deepEqual(s.readiness.types(), ['teams']);
    s.readiness.unregisterChannel('@omadia/channel-teams');
    assert.deepEqual(s.readiness.types(), []);
  });

  it('a channel type is held by the first plugin that acts for it, until that plugin deactivates', () => {
    const claims = new ChannelTypeClaims();
    assert.equal(claims.claim('@omadia/channel-teams', 'teams'), true);
    assert.equal(claims.claim('@omadia/channel-teams', 'teams'), true, 'its own again');
    assert.equal(claims.claim('@acme/other', 'teams'), false);
    assert.equal(claims.claim('@acme/other', 'slack'), true, 'a plugin may serve a type nobody holds');
    claims.release('@omadia/channel-teams');
    assert.equal(claims.ownerOf('teams'), undefined);
    assert.equal(claims.claim('@acme/other', 'teams'), true);
  });

  it('everything else of CoreApi is the shared object', async () => {
    const s = await setup();
    const core = createCoreApi({ dispatcher: {} as never, routes: {} as never });
    const scoped = scopeCoreApiToChannel(core, 'c', new ChannelTypeClaims());
    assert.equal(scoped.handleTurnStream, core.handleTurnStream);
    assert.equal(scoped.registerRoute, core.registerRoute);
    assert.equal(scoped.emitConversationMessage, undefined, 'still feature-detectable');
    assert.ok(s.teams.emitConversationMessage);
  });
});
