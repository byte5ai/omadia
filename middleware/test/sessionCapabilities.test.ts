/**
 * Channel readiness, meeting sources, session capabilities and meeting
 * lifecycle events (#2043, #2077) — the kernel side.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  ChannelReadinessProvider,
  MeetingSourceProvider,
  SessionEvent,
} from '@omadia/channel-sdk';
import type {
  ChannelReadinessReport,
  SessionCapabilitySnapshot,
  SessionEventRecord,
} from '@omadia/plugin-api';

import { createCoreApi } from '../src/channels/coreApi.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { SessionCapabilityHub } from '../src/channels/sessionCapabilities/hub.js';
import { ChannelProviderRegistry } from '../src/channels/sessionCapabilities/providerRegistry.js';
import {
  createChannelReadinessService,
  createSessionCapabilitiesService,
} from '../src/channels/sessionCapabilities/services.js';
import {
  CONVERSATION,
  ENGINE,
  hubFixture,
  MARA_KEY,
  scopeOf,
} from './_helpers/conversationMessagesFixture.js';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const READY: ChannelReadinessReport = {
  ready: true,
  installed: true,
  canReadAllMessages: true,
  canPost: true,
  missing: [],
};

async function setup() {
  const messages = hubFixture(new InMemoryConversationMessageStore());
  const readiness = new ChannelProviderRegistry<ChannelReadinessProvider>('readiness');
  const meetingSources = new ChannelProviderRegistry<MeetingSourceProvider>('meetingSource');
  const logs: string[] = [];
  const hub = new SessionCapabilityHub({
    readiness,
    meetingSources,
    identityFor: (slug) => (slug === 'mara' ? { channelKey: MARA_KEY } : slug === 'nora' ? { channelKey: '28:bbbb-nora' } : undefined),
    subscriptionsIn: (type, conversation) => messages.hub.subscriptionsIn(type, conversation),
    principalOf: (user) => `user:${user.id.toLowerCase()}`,
    now: () => new Date('2026-11-18T09:00:00.000Z'),
    log: (m) => logs.push(m),
  });
  return { messages, readiness, meetingSources, hub, logs };
}

const request = { agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION };

describe('provider registries', () => {
  it('one provider per channel type, owned by its channel, dropped on deactivate', () => {
    const registry = new ChannelProviderRegistry<ChannelReadinessProvider>('readiness');
    const first: ChannelReadinessProvider = { channelType: 'teams', check: () => Promise.resolve(READY) };
    const second: ChannelReadinessProvider = { channelType: 'teams', check: () => Promise.resolve(READY) };
    registry.register('@omadia/channel-teams', first);
    registry.register('@omadia/channel-teams', second); // own replace is fine
    assert.equal(registry.get('teams'), second);
    assert.throws(() => registry.register('@acme/fake-teams', first), /already owned by channel '@omadia\/channel-teams'/);
    registry.unregisterChannel('@acme/fake-teams');
    assert.deepEqual(registry.types(), ['teams']);
    registry.unregisterChannel('@omadia/channel-teams');
    assert.equal(registry.get('teams'), undefined);
  });

  it('CoreApi offers the register and emit methods only when wired', async () => {
    const base = { dispatcher: {} as never, routes: {} as never };
    const bare = createCoreApi(base);
    assert.equal(bare.registerReadinessProvider, undefined);
    assert.equal(bare.registerMeetingSourceProvider, undefined);
    assert.equal(bare.emitSessionCapabilities, undefined);
    assert.equal(bare.emitSessionEvent, undefined);
    const s = await setup();
    const api = createCoreApi({
      ...base,
      readinessProviders: s.readiness,
      meetingSources: s.meetingSources,
      sessionCapabilities: s.hub,
    });
    api.registerReadinessProvider!('@omadia/channel-teams', { channelType: 'teams', check: () => Promise.resolve(READY) });
    api.registerMeetingSourceProvider!('@omadia/channel-teams', { channelType: 'teams', snapshot: () => Promise.resolve(undefined) });
    assert.deepEqual(s.readiness.types(), ['teams']);
    assert.deepEqual(s.meetingSources.types(), ['teams']);
    assert.doesNotThrow(() => api.emitSessionCapabilities!(null as never));
    assert.doesNotThrow(() => api.emitSessionEvent!({} as never));
  });
});

describe('channel readiness', () => {
  it('asks the provider as the agent own identity and returns its report', async () => {
    const s = await setup();
    const asked: unknown[] = [];
    const report: ChannelReadinessReport = {
      ready: false,
      installed: true,
      canReadAllMessages: false,
      canPost: true,
      missing: [{ code: 'consent_missing', message: 'ChatMessage.Read.Chat is not granted in this chat' }],
    };
    s.readiness.register('c', {
      channelType: 'teams',
      check: (conversationId, opts) => {
        asked.push([conversationId, opts]);
        return Promise.resolve(report);
      },
    });
    assert.deepEqual(await s.hub.check(request), report);
    assert.deepEqual(asked, [[CONVERSATION, { asChannelKey: MARA_KEY }]]);
  });

  it('no identity, no provider, and a throwing provider are each stated honestly', async () => {
    const s = await setup();
    const none = await s.hub.check({ ...request, agentSlug: 'ida' });
    assert.deepEqual([none.ready, none.missing[0]!.code], [false, 'no_identity']);
    // No provider: the channel never declared that it delivers every message.
    const undeclared = await s.hub.check(request);
    assert.equal(undeclared.ready, false);
    assert.equal(undeclared.missing[0]!.code, 'unsupported_conversation');
    assert.match(undeclared.missing[0]!.message, /does not declare delivery of all messages/);
    assert.equal(await s.hub.checkIdentity('teams', CONVERSATION, MARA_KEY), undefined);
    s.readiness.register('c', { channelType: 'teams', check: () => Promise.reject(new Error('503 from Graph')) });
    const failed = await s.hub.check(request);
    assert.equal(failed.ready, false);
    assert.deepEqual(failed.missing, [{ code: 'graph_error', message: 'the readiness check failed: 503 from Graph' }]);
  });

  it('the readiness report decides a message subscription', async () => {
    const s = await setup();
    s.messages.readiness = {
      ready: false,
      installed: true,
      canReadAllMessages: false,
      canPost: true,
      missing: [{ code: 'graph_forbidden', message: 'the instance app may not read installations' }],
    };
    const refused = await s.messages.hub.subscribe(scopeOf('mara'), ENGINE);
    assert.equal(refused.outcome === 'refused' && refused.code, 'not_ready');
    assert.match(refused.outcome === 'refused' ? refused.message : '', /graph_forbidden: the instance app may not read installations/);
  });

  it('repairConsent passes through, and says so when the channel has none', async () => {
    const s = await setup();
    const unsupported = await s.hub.repairConsent(request);
    assert.deepEqual([unsupported.outcome, unsupported.outcome === 'failed' && unsupported.code], ['failed', 'unsupported']);
    const noIdentity = await s.hub.repairConsent({ ...request, agentSlug: 'ida' });
    assert.equal(noIdentity.outcome === 'failed' && noIdentity.code, 'no_identity');
    s.readiness.register('c', {
      channelType: 'teams',
      check: () => Promise.resolve(READY),
      repairConsent: (conversationId, opts) =>
        Promise.resolve(
          conversationId === CONVERSATION && opts.asChannelKey === MARA_KEY
            ? { outcome: 'upgraded', installationId: 'inst-1', permissions: ['ChatMessage.Read.Chat'] }
            : {
                outcome: 'failed',
                code: 'graph_forbidden',
                message: 'AppCatalog.ReadWrite.All is not granted to the instance app',
              },
        ),
    });
    assert.deepEqual(await s.hub.repairConsent(request), {
      outcome: 'upgraded',
      installationId: 'inst-1',
      permissions: ['ChatMessage.Read.Chat'],
    });
    // A missing Graph permission comes back as a clean reason.
    assert.deepEqual(await s.hub.repairConsent({ ...request, conversationId: '19:other@thread.v2' }), {
      outcome: 'failed',
      code: 'graph_forbidden',
      message: 'AppCatalog.ReadWrite.All is not granted to the instance app',
    });
  });
});

describe('session capabilities', () => {
  const online: SessionCapabilitySnapshot = {
    channelType: 'teams',
    conversationId: CONVERSATION,
    modality: 'online',
    inputs: ['text', 'message_edits', 'card_answers'],
    outputs: ['text', 'mentions', 'cards', 'polls', 'private_messages'],
    capturedAt: '2026-11-18T09:30:00.000Z',
  };

  it('reports the chat baseline without a meeting source, and when the source knows nothing', async () => {
    const s = await setup();
    const baseline = {
      channelType: 'teams',
      conversationId: CONVERSATION,
      modality: 'chat',
      inputs: ['text'],
      outputs: ['text'],
      capturedAt: '2026-11-18T09:00:00.000Z',
    };
    assert.deepEqual(await s.hub.getSnapshot(request), baseline);
    const asked: unknown[] = [];
    s.meetingSources.register('c', {
      channelType: 'teams',
      snapshot: (conversationId, opts) => {
        asked.push([conversationId, opts]);
        if (conversationId === 'boom') return Promise.reject(new Error('graph down'));
        return Promise.resolve(conversationId === CONVERSATION ? online : undefined);
      },
    });
    assert.deepEqual(await s.hub.getSnapshot({ ...request, sessionRef: 'meeting-1' }), online);
    assert.deepEqual(asked[0], [CONVERSATION, { asChannelKey: MARA_KEY, sessionRef: 'meeting-1' }]);
    assert.deepEqual(await s.hub.getSnapshot({ ...request, conversationId: '19:unknown@thread.v2' }), {
      ...baseline,
      conversationId: '19:unknown@thread.v2',
    });
    assert.equal((await s.hub.getSnapshot({ ...request, conversationId: 'boom' })).modality, 'chat');
  });

  it('pushes a changed snapshot only to the engine that moderates the conversation', async () => {
    const s = await setup();
    const got: string[] = [];
    s.hub.onSnapshot('mara', ENGINE, (snap) => void got.push(`mara:${snap.modality}`));
    s.hub.onSnapshot('nora', ENGINE, (snap) => void got.push(`nora:${snap.modality}`));
    s.hub.onSnapshot('mara', '@acme/snoop', () => void got.push('snoop'));
    s.hub.emitSnapshot(online);
    await flush();
    assert.deepEqual(got, [], 'nobody is subscribed yet');
    await s.messages.hub.subscribe(scopeOf('mara'), ENGINE);
    s.hub.emitSnapshot(online);
    s.hub.emitSnapshot({ ...online, conversationId: '19:other@thread.v2' });
    await flush();
    assert.deepEqual(got, ['mara:online']);
  });
});

describe('session events (meeting lifecycle)', () => {
  const event = (over: Partial<SessionEvent> = {}): SessionEvent => ({
    channelId: '@omadia/channel-teams',
    channelType: 'teams',
    conversationId: CONVERSATION,
    sessionRef: 'meeting-1',
    kind: 'session_started',
    occurredAt: '2026-11-18T10:00:00Z',
    ...over,
  });

  it('delivers only where the engine holds a subscription, with principal ids, once per platform event', async () => {
    const s = await setup();
    const got: SessionEventRecord[] = [];
    const foreign: SessionEventRecord[] = [];
    s.hub.onSessionEvent('mara', ENGINE, (e) => void got.push(e));
    s.hub.onSessionEvent('nora', ENGINE, (e) => void foreign.push(e));
    s.hub.onSessionEvent('mara', '@acme/snoop', (e) => void foreign.push(e));

    s.hub.emitSessionEvent(event()); // emitted for every meeting, subscribed or not
    await flush();
    assert.deepEqual(got, [], 'dropped: no subscription');

    await s.messages.hub.subscribe(scopeOf('mara'), ENGINE);
    const joined = event({
      kind: 'participant_joined',
      occurredAt: '2026-11-18T10:01:00Z',
      participants: [
        { kind: 'teams-aad', id: 'AAD-Anna', displayName: 'Anna Köhler' },
        { kind: 'teams-aad', id: '' } as never,
      ],
    });
    s.hub.emitSessionEvent(event());
    s.hub.emitSessionEvent(event()); // the second bot in the chat reports the same start
    s.hub.emitSessionEvent(joined);
    s.hub.emitSessionEvent({ ...joined });
    s.hub.emitSessionEvent(event({ conversationId: '19:other@thread.v2' }));
    s.hub.emitSessionEvent(event({ kind: 'session_ended', occurredAt: '2026-11-18T11:00:00Z', participants: [{ kind: 'teams-aad', id: 'x' }] }));
    await flush();
    assert.deepEqual(got, [
      {
        channelType: 'teams',
        conversationId: CONVERSATION,
        sessionRef: 'meeting-1',
        kind: 'session_started',
        occurredAt: '2026-11-18T10:00:00.000Z',
      },
      {
        channelType: 'teams',
        conversationId: CONVERSATION,
        sessionRef: 'meeting-1',
        kind: 'participant_joined',
        participants: [
          { kind: 'teams-aad', id: 'AAD-Anna', displayName: 'Anna Köhler', principalId: 'user:aad-anna' },
        ],
        occurredAt: '2026-11-18T10:01:00.000Z',
      },
      {
        channelType: 'teams',
        conversationId: CONVERSATION,
        sessionRef: 'meeting-1',
        kind: 'session_ended',
        occurredAt: '2026-11-18T11:00:00.000Z',
      },
    ]);
    assert.deepEqual(foreign, []);
  });

  it('drops malformed events and survives a failing handler', async () => {
    const s = await setup();
    await s.messages.hub.subscribe(scopeOf('mara'), ENGINE);
    const got: SessionEventRecord[] = [];
    s.hub.onSessionEvent('mara', ENGINE, () => {
      throw new Error('engine hiccup');
    });
    const dispose = s.hub.onSessionEvent('mara', ENGINE, (e) => void got.push(e));
    for (const bad of [
      event({ kind: 'meeting_paused' as never }),
      event({ sessionRef: '' }),
      event({ occurredAt: 'soon' }),
      null as never,
    ]) {
      s.hub.emitSessionEvent(bad);
    }
    s.hub.emitSessionEvent(event());
    await flush();
    await flush();
    assert.equal(got.length, 1);
    assert.equal(s.logs.filter((l) => /dropped an invalid session event/.test(l)).length, 4);
    assert.ok(s.logs.some((l) => /session event handler for 'mara' failed: engine hiccup/.test(l)));
    dispose();
    s.hub.emitSessionEvent(event({ occurredAt: '2026-11-18T12:00:00Z' }));
    await flush();
    assert.equal(got.length, 1);
  });
});

describe('plugin-facing services', () => {
  it('answer the facilitation engine only', async () => {
    const s = await setup();
    await s.messages.hub.subscribe(scopeOf('mara'), ENGINE);
    s.readiness.register('c', { channelType: 'teams', check: () => Promise.resolve(READY) });
    const engine = { callerPluginId: ENGINE, isEngine: () => true };
    const other = { callerPluginId: '@acme/crm', isEngine: () => false };
    assert.deepEqual(await createChannelReadinessService(s.hub, engine).check(request), READY);
    const refused = await createChannelReadinessService(s.hub, other).check(request);
    assert.equal(refused.ready, false);
    const repair = await createChannelReadinessService(s.hub, other).repairConsent!(request);
    assert.equal(repair.outcome === 'failed' && repair.code, 'unsupported');

    const got: string[] = [];
    createSessionCapabilitiesService(s.hub, engine).onSessionEvent!('mara', (e) => void got.push(`engine:${e.kind}`));
    createSessionCapabilitiesService(s.hub, other).onSessionEvent!('mara', (e) => void got.push(`other:${e.kind}`));
    createSessionCapabilitiesService(s.hub, other).onChange('mara', () => void got.push('other:snapshot'));
    s.hub.emitSessionEvent({
      channelId: 'c',
      channelType: 'teams',
      conversationId: CONVERSATION,
      sessionRef: 'm',
      kind: 'session_started',
      occurredAt: '2026-11-18T10:00:00Z',
    });
    await flush();
    assert.deepEqual(got, ['engine:session_started']);
    const baseline = await createSessionCapabilitiesService(s.hub, other).getSnapshot(request);
    assert.deepEqual([baseline.modality, baseline.inputs], ['chat', ['text']]);
  });
});
