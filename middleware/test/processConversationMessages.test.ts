/**
 * #2089 (spec 2043 §0, §5.3, criterion 53) — 'conversationMessages@2':
 * subscriptions and reads bound to a process.
 *
 * The rule under test: which process an inbound message belongs to is decided
 * before it is stored, so no read path (single event, list, replay, live
 * delivery) of one process can return what another process received.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ProcessConversationMessageRecord } from '@omadia/plugin-api';

import { ConversationMessageHub, type ProcessAccess } from '../src/channels/conversationMessages/hub.js';
import { createProcessConversationMessagesService } from '../src/channels/conversationMessages/service.js';
import { InMemoryConversationMessageStore } from '../src/channels/conversationMessages/store.js';
import { createFacilitatorRuntimeLookup } from '../src/platform/facilitatorRuntimeService.js';
import { CONVERSATION, ENGINE, MARA_KEY, messageEvent } from './_helpers/conversationMessagesFixture.js';

const OTHER_PLUGIN = '@acme/other-archetype';
const READY = { ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [] };

function setup() {
  const store = new InMemoryConversationMessageStore();
  /** processId → what it may read; a process that is not listed has nothing. */
  const access = new Map<string, ProcessAccess>();
  const logs: string[] = [];
  let ready = true;
  const hub = new ConversationMessageHub({
    store,
    resolveAgent: (slug) => (slug === 'mara' ? { id: 'id-mara', slug, archetype: 'facilitator' } : slug === 'hr' ? { id: 'id-hr', slug, archetype: 'standard' } : undefined),
    identityFor: (slug) => (slug === 'mara' ? { channelKey: MARA_KEY } : undefined),
    isBotPresent: () => Promise.resolve(true),
    checkReadiness: () => Promise.resolve(ready ? READY : { ...READY, ready: false, canReadAllMessages: false, missing: [{ code: 'rsc_missing', message: 'no permission to read all messages' }] } as never),
    processAccess: ({ pluginId, processId }) =>
      Promise.resolve(access.get(`${pluginId}|${processId}`) ?? { reserved: false, everReserved: false, openScope: false }),
    groundFor: () => Promise.resolve(undefined),
    log: (m) => logs.push(m),
  });
  const service = createProcessConversationMessagesService({ hub, callerPluginId: ENGINE });
  const scope = (processId: string, conversationId = CONVERSATION) => ({ agentSlug: 'mara', channelType: 'teams', conversationId, processId });
  const grant = (processId: string, a: Partial<ProcessAccess>, pluginId = ENGINE): void => {
    access.set(`${pluginId}|${processId}`, { reserved: true, everReserved: true, openScope: true, ...a });
  };
  const ids = async (processId: string): Promise<string[]> =>
    (await service.listSince(scope(processId))).events.map((e) => e.messageId);
  return { hub, store, service, scope, grant, ids, logs, setReady: (v: boolean) => void (ready = v) };
}

describe('#2089 subscribing a process', () => {
  it('every message needs the reservation, every mode an open scope', async () => {
    const h = setup();
    const refusal = async (processId: string, mode: 'all' | 'addressed'): Promise<string | undefined> => {
      const outcome = await h.service.subscribe(h.scope(processId), { mode });
      return outcome.outcome === 'refused' ? outcome.code : undefined;
    };
    assert.equal(await refusal('unknown', 'all'), 'no_scope');
    h.grant('f1', { openScope: false });
    assert.equal(await refusal('f1', 'all'), 'no_scope');
    h.grant('f1', { reserved: false });
    assert.equal(await refusal('f1', 'all'), 'not_reserved', 'held once is not enough for every message');
    assert.equal(await refusal('f1', 'addressed'), undefined, 'but enough for addressed ones');
    h.grant('f2', { reserved: false, everReserved: false });
    assert.equal(await refusal('f2', 'addressed'), 'not_reserved', 'a conversation the process never held');
    h.grant('f3', {});
    assert.deepEqual(await h.service.subscribe(h.scope('f3'), { mode: 'all' }), { outcome: 'subscribed', mode: 'all' });
  });

  it('checks the archetype and the own identity, and readiness for every message only', async () => {
    const h = setup();
    h.grant('f1', {});
    const hr = await h.service.subscribe({ ...h.scope('f1'), agentSlug: 'hr' }, { mode: 'all' });
    assert.equal(hr.outcome === 'refused' && hr.code, 'not_facilitator');
    h.setReady(false);
    const all = await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    assert.equal(all.outcome === 'refused' && all.code, 'not_ready');
    assert.equal((await h.service.subscribe(h.scope('f1'), { mode: 'addressed' })).outcome, 'subscribed', 'addressed messages need no permission for all');
  });

  it('the channel is told what the identity gets: all, addressed or nothing', async () => {
    const h = setup();
    const mode = (): string => h.hub.deliveryMode('teams', CONVERSATION, MARA_KEY);
    assert.equal(mode(), 'none');
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    assert.deepEqual([mode(), h.hub.isSubscribed('teams', CONVERSATION, MARA_KEY)], ['addressed', false]);
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    assert.deepEqual([mode(), h.hub.isSubscribed('teams', CONVERSATION, MARA_KEY)], ['all', true]);
    assert.equal(await h.service.modeOf(h.scope('f1')), 'all');
    await h.service.subscribe(h.scope('f1'), { mode: 'none' });
    assert.deepEqual([mode(), h.hub.isSubscribed('teams', CONVERSATION, MARA_KEY)], ['none', false]);
  });

  it('a channel-started turn is suppressed exactly where a process reads everything', async () => {
    // The kernel's lookup for the orchestrator (`facilitatorConversations`):
    // in such a conversation the engine answers, so a mention must not get a
    // second answer from the facilitator's ordinary turn.
    const h = setup();
    const lookup = createFacilitatorRuntimeLookup({
      getRegistry: () => undefined,
      getMessages: () => h.hub,
      engineSources: () => ({}) as never,
      reportedEngineState: () => undefined,
    });
    const driven = (): boolean => lookup.isEngineDriven('mara', 'teams', CONVERSATION);
    assert.equal(driven(), false);
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    assert.equal(driven(), true);
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    assert.equal(driven(), false, 'in follow-up the ordinary turn runs');
    assert.equal(lookup.isEngineDriven('nora', 'teams', CONVERSATION), false);
  });

});

describe('#2089 no reading across processes (criterion 53)', () => {
  it('two facilitations one after another: the second gets none of the first\'s events, the first keeps its own', async () => {
    const h = setup();
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    await h.hub.ingest(messageEvent({ messageId: 'm1', text: 'vote A' }));
    await h.hub.ingest(messageEvent({ messageId: 'm2', text: 'vote B' }));
    // F1 closes: it stops reading but can still resume its own closing.
    await h.service.subscribe(h.scope('f1'), { mode: 'none' });
    h.grant('f1', { reserved: false });
    h.grant('f2', {});
    await h.service.subscribe(h.scope('f2'), { mode: 'all' });
    await h.hub.ingest(messageEvent({ messageId: 'm3', text: 'new topic' }));

    assert.deepEqual(await h.ids('f1'), ['m1', 'm2']);
    assert.deepEqual(await h.ids('f2'), ['m3']);
    assert.equal(await h.service.getEvent(h.scope('f2'), 'm1'), undefined, 'single event');
    const m1 = await h.service.getEvent(h.scope('f1'), 'm1');
    assert.equal(m1?.processId, 'f1');
    assert.equal(await h.service.getEventById(h.scope('f2'), m1!.eventId), undefined, 'by event id');
    assert.equal(await h.service.getEvent(h.scope('f1'), 'm3'), undefined, 'and not the other way round');
  });

  it('overlap: a reply or card answer bound to the older process reaches it alone', async () => {
    const h = setup();
    h.grant('f1', { reserved: false }); // in follow-up: held the conversation once
    h.grant('f2', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    await h.service.subscribe(h.scope('f2'), { mode: 'all' });
    assert.equal(await h.service.bindMessage(h.scope('f1'), { messageId: 'reminder-1', cardId: 'card-done-1' }), true);

    const live: ProcessConversationMessageRecord[] = [];
    h.service.onMessage('mara', (record) => void live.push(record));

    await h.hub.ingest(messageEvent({ messageId: 'u1', text: 'option A for me' }));
    await h.hub.ingest(messageEvent({ messageId: 'u2', text: 'erledigt', replyToMessageId: 'reminder-1' }));
    await h.hub.ingest(messageEvent({ messageId: 'reminder-1', kind: 'reaction', reaction: { name: 'like', removed: false } }));
    await h.hub.ingest(
      messageEvent({ messageId: 'card-msg-9', kind: 'card_answer', text: undefined, cardAnswer: { cardId: 'card-done-1', value: { done: true } } }),
    );
    await h.hub.ingest(messageEvent({ messageId: 'u3', text: '@Mara stop', addressedToBot: true }));
    await new Promise((r) => setImmediate(r));

    // F2 (moderating) never sees what was bound to F1: not in its list, not
    // as a single event, not live.
    assert.deepEqual(await h.ids('f2'), ['u1', 'u3']);
    assert.equal(await h.service.getEvent(h.scope('f2'), 'u2'), undefined);
    assert.deepEqual(await h.ids('f1'), ['u2', 'reminder-1', 'card-msg-9', 'u3']);
    assert.deepEqual(
      live.map((r) => `${r.processId}:${r.messageId}`).sort(),
      ['f1:card-msg-9', 'f1:reminder-1', 'f1:u2', 'f1:u3', 'f2:u1', 'f2:u3'].sort(),
    );
    // An unreferenced message that addresses the facilitator reaches both;
    // which process "stop" means is the plugin's question to ask.
    assert.equal((await h.service.getEvent(h.scope('f1'), 'u3'))?.addressedToBot, true);
  });

  it('an addressed-only process gets nothing that is neither addressed nor bound to it', async () => {
    const h = setup();
    h.grant('f1', { reserved: false });
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    await h.hub.ingest(messageEvent({ messageId: 'u1', text: 'lunch?' }));
    await h.hub.ingest(messageEvent({ messageId: 'u2', text: 'reply to somebody', replyToMessageId: 'not-the-bots' }));
    assert.deepEqual(await h.ids('f1'), []);
  });

  it('the first binding stands, and only a process with a subscription here binds', async () => {
    const h = setup();
    h.grant('f1', {});
    h.grant('f2', { reserved: false });
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    assert.equal(await h.service.bindMessage(h.scope('f2'), { messageId: 'x' }), false, 'no subscription');
    await h.service.subscribe(h.scope('f2'), { mode: 'addressed' });
    assert.equal(await h.service.bindMessage(h.scope('f1'), { messageId: 'x' }), true);
    assert.equal(await h.service.bindMessage(h.scope('f1'), { messageId: 'x' }), true, 'again, same process');
    assert.equal(await h.service.bindMessage(h.scope('f2'), { messageId: 'x' }), false, "already another process's");
    assert.equal(await h.service.bindMessage(h.scope('f1'), {}), false);
  });

  it('another plugin reads nothing of a process, also with the same process id', async () => {
    const h = setup();
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    await h.hub.ingest(messageEvent({ messageId: 'm1' }));
    const other = createProcessConversationMessagesService({ hub: h.hub, callerPluginId: OTHER_PLUGIN });
    assert.deepEqual((await other.listSince(h.scope('f1'))).events, []);
    assert.equal(await other.getEvent(h.scope('f1'), 'm1'), undefined);
    assert.equal(await other.modeOf(h.scope('f1')), undefined);
    const seen: unknown[] = [];
    other.onMessage('mara', (r) => void seen.push(r));
    await h.hub.ingest(messageEvent({ messageId: 'm2' }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, []);
  });

  it('keeps the order of a message and its edit', async () => {
    const h = setup();
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    const stored = await Promise.all([
      h.hub.ingest(messageEvent({ messageId: 'm1', text: 'A' })),
      h.hub.ingest(messageEvent({ messageId: 'm1', kind: 'edited', text: 'B' })),
    ]);
    assert.deepEqual(stored.map((r) => r?.revision), [0, 1]);
    assert.equal((await h.service.getEvent(h.scope('f1'), 'm1'))?.text, 'B');
  });
});

describe('#2089 transcript segments (contract, no producer yet)', () => {
  const segment = (over: Record<string, unknown> = {}) =>
    messageEvent({
      kind: 'transcript_segment',
      messageId: 'seg-1',
      text: 'I would go with option B.',
      author: { kind: 'teams-aad', id: 'AAD-Anna', displayName: 'Anna Köhler' },
      transcript: { sessionId: 'session-3', segmentId: 'seg-1', source: 'participant' },
      ...over,
    } as never);

  it('stores a segment like a message: read by event id, revisions counted per segment', async () => {
    const h = setup();
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    const first = await h.hub.ingest(segment());
    const again = await h.hub.ingest(segment());
    const corrected = await h.hub.ingest(segment({ text: 'I would go with option D.' }));
    assert.deepEqual([first?.revision, again, corrected?.revision], [0, undefined, 1], 'the same text again is a redelivery');
    const read = await h.service.getEventById(h.scope('f1'), corrected!.eventId);
    assert.deepEqual(
      [read?.kind, read?.messageId, read?.text, read?.transcript, read?.author.id, read?.processId],
      ['transcript_segment', 'seg-1', 'I would go with option D.', { sessionId: 'session-3', segmentId: 'seg-1', source: 'participant' }, 'AAD-Anna', 'f1'],
    );
    // A message with the same id is a different thing with its own revisions.
    const message = await h.hub.ingest(messageEvent({ messageId: 'seg-1', text: 'typed' }));
    assert.equal(message?.revision, 0);
  });

  it('a shared source has no author: it names the media source and may carry a hint', async () => {
    const h = setup();
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    const shared = await h.hub.ingest(
      segment({
        author: { kind: 'custom', id: 'media:room-mic-2' },
        transcript: { sessionId: 'session-3', segmentId: 'seg-1', source: 'shared', speakerHint: 'probably Bert' },
      }),
    );
    assert.deepEqual(shared?.transcript, { sessionId: 'session-3', segmentId: 'seg-1', source: 'shared', speakerHint: 'probably Bert' });
    assert.equal(shared?.author.id, 'media:room-mic-2');
  });

  it('refuses what is not a transcript segment', async () => {
    const h = setup();
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    const bad = [
      segment({ transcript: undefined }),
      segment({ transcript: { sessionId: '', segmentId: 'seg-1', source: 'participant' } }),
      segment({ transcript: { sessionId: 's', segmentId: 'another', source: 'participant' } }),
      segment({ transcript: { sessionId: 's', segmentId: 'seg-1', source: 'room' } }),
      segment({ text: '   ' }),
      // A shared stream that claims a person as its author.
      segment({ transcript: { sessionId: 's', segmentId: 'seg-1', source: 'shared' } }),
      // A message that smuggles a transcript in.
      messageEvent({ messageId: 'm9', transcript: { sessionId: 's', segmentId: 'm9', source: 'participant' } } as never),
    ];
    for (const event of bad) assert.equal(await h.hub.ingest(event), undefined);
    assert.deepEqual(await h.ids('f1'), []);
    assert.equal(h.logs.filter((l) => l.includes('dropped an invalid event')).length, bad.length);
  });

  it('goes to the process that reads everything, not to one in follow-up', async () => {
    const h = setup();
    h.grant('f1', { reserved: false });
    h.grant('f2', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'addressed' });
    await h.service.subscribe(h.scope('f2'), { mode: 'all' });
    await h.hub.ingest(segment());
    assert.deepEqual([await h.ids('f1'), await h.ids('f2')], [[], ['seg-1']]);
  });
});

describe('#2089 access ends with the permission', () => {
  it('reservation released: every-message reading is turned down to addressed', async () => {
    const h = setup();
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    h.grant('f1', { reserved: false });
    assert.deepEqual(await h.hub.reconcile(), []);
    assert.equal(await h.service.modeOf(h.scope('f1')), 'addressed');
    assert.equal(h.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false, 'the mention gate is back on');
    await h.hub.ingest(messageEvent({ messageId: 'late-vote', text: 'A' }));
    assert.deepEqual(await h.ids('f1'), []);
  });

  it('no open scope left: the subscription ends, reads end, and it never re-opens', async () => {
    const h = setup();
    h.grant('f1', {});
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    await h.hub.ingest(messageEvent({ messageId: 'm1' }));
    h.grant('f1', { reserved: false, openScope: false });
    const ended = await h.hub.reconcile();
    assert.equal(ended.length, 1);
    assert.match(ended[0]!.reason, /no open execution scope/);
    assert.deepEqual(await h.ids('f1'), []);
    assert.equal(await h.service.getEvent(h.scope('f1'), 'm1'), undefined);
    h.grant('f1', {});
    const again = await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    assert.equal(again.outcome === 'refused' && again.code, 'ended');
  });

  it('end of service ends process subscriptions like the others', async () => {
    const h = setup();
    h.grant('f1', {});
    h.grant('f2', { reserved: false });
    await h.service.subscribe(h.scope('f1'), { mode: 'all' });
    await h.service.subscribe(h.scope('f2', '19:other@thread.v2'), { mode: 'addressed' });
    const ended = await h.hub.endAllOf('mara', 'agent disabled');
    assert.equal(ended.length, 2);
    assert.equal(h.hub.deliveryMode('teams', CONVERSATION, MARA_KEY), 'none');
  });

  it('events of a running process are not purged by age; after it ended they go with the grace period', async () => {
    let now = Date.parse('2026-11-18T09:00:00.000Z');
    const store = new InMemoryConversationMessageStore(() => new Date(now));
    const created = await store.createProcessSubscription({
      agentId: 'id-mara', agentSlug: 'mara', channelType: 'teams', conversationId: CONVERSATION,
      channelKey: MARA_KEY, pluginId: ENGINE, processId: 'f1', mode: 'all',
    });
    await store.insertEvent(created.subscription, { messageId: 'old', kind: 'created', author: { kind: 'teams-aad', id: 'a' }, occurredAt: new Date(now).toISOString() });
    now += 40 * 24 * 3_600_000;
    assert.deepEqual(await store.purge({ endedBefore: new Date(now), receivedBefore: new Date(now - 30 * 24 * 3_600_000) }), { events: 0, subscriptions: 0 });
    await store.endSubscription(created.subscription.id);
    now += 7 * 3_600_000;
    assert.deepEqual(await store.purge({ endedBefore: new Date(now - 6 * 3_600_000) }), { events: 1, subscriptions: 1 });
  });
});
