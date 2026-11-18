/**
 * 'conversationMessages@1' (#2043) — the kernel's record of who wrote what.
 *
 * Runs on the in-memory store, which follows the same rules as the Postgres
 * one (`conversationMessages.pg.test.ts` proves those against the real
 * migration, including a restart).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ConversationMessageRecord } from '@omadia/plugin-api';

import { createCoreApi } from '../src/channels/coreApi.js';
import { startConversationMessagePurge } from '../src/channels/conversationMessages/purgeJob.js';
import { createConversationMessagesService } from '../src/channels/conversationMessages/service.js';
import {
  assignRevision,
  InMemoryConversationMessageStore,
} from '../src/channels/conversationMessages/store.js';
import {
  createBotPresenceCheck,
  principalOfChannelUser,
} from '../src/channels/conversationMessages/wiring.js';
import {
  CONVERSATION,
  ENGINE,
  hubFixture,
  MARA_KEY,
  messageEvent,
  NORA_KEY,
  scopeOf,
} from './_helpers/conversationMessagesFixture.js';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('conversationMessages: subscribe', () => {
  it('subscribes a facilitator with its own identity, idempotently', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    assert.deepEqual(await f.hub.subscribe(scopeOf('mara'), ENGINE), { outcome: 'subscribed' });
    assert.deepEqual(await f.hub.subscribe(scopeOf('mara'), ENGINE), { outcome: 'subscribed' });
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true);
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY.toLowerCase()), true, 'lower-case key');
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, NORA_KEY), false, 'another bot in the same chat');
    assert.equal(f.hub.isSubscribed('teams', '19:other@thread.v2', MARA_KEY), false);
    assert.equal(f.hub.isSubscribed('slack', CONVERSATION, MARA_KEY), false);
  });

  const refusals: readonly [string, string, RegExp, ((f: ReturnType<typeof hubFixture>) => void)?][] = [
    ['hr', 'not_facilitator', /not a facilitator/],
    ['ida', 'no_identity', /no identity of its own/],
    ['ghost', 'unavailable', /not active/],
    ['mara', 'not_present', /not observed in this conversation/, (f) => f.present.clear()],
    [
      'mara',
      'not_ready',
      /consent_missing: RSC ChatMessage\.Read\.Chat is not consented/,
      (f) => {
        f.readiness = {
          ready: false,
          installed: true,
          canReadAllMessages: false,
          canPost: true,
          missing: [{ code: 'consent_missing', message: 'RSC ChatMessage.Read.Chat is not consented in this chat' }],
        };
      },
    ],
  ];
  for (const [slug, code, message, arrange] of refusals) {
    it(`refuses ${slug}: ${code}`, async () => {
      const f = hubFixture(new InMemoryConversationMessageStore());
      arrange?.(f);
      const outcome = await f.hub.subscribe(scopeOf(slug), ENGINE);
      assert.equal(outcome.outcome, 'refused');
      assert.equal(outcome.outcome === 'refused' && outcome.code, code);
      assert.match(outcome.outcome === 'refused' ? outcome.message : '', message);
      assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
    });
  }

  it('readiness ok, and no readiness provider at all, both subscribe', async () => {
    const ready = hubFixture(new InMemoryConversationMessageStore());
    ready.readiness = { ready: true, installed: true, canReadAllMessages: true, canPost: true, missing: [] };
    assert.equal((await ready.hub.subscribe(scopeOf('mara'), ENGINE)).outcome, 'subscribed');
    const none = hubFixture(new InMemoryConversationMessageStore());
    assert.equal((await none.hub.subscribe(scopeOf('mara'), ENGINE)).outcome, 'subscribed');
  });

  it('a second plugin cannot take over or read a subscription', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    const other = await f.hub.subscribe(scopeOf('mara'), '@acme/snoop');
    assert.equal(other.outcome === 'refused' && other.code, 'unavailable');
    await f.hub.ingest(messageEvent());
    assert.equal(await f.hub.getEvent(scopeOf('mara'), '@acme/snoop', 'm1'), undefined);
    assert.deepEqual(await f.hub.listSince(scopeOf('mara'), '@acme/snoop'), { events: [] });
    await f.hub.unsubscribe(scopeOf('mara'), '@acme/snoop');
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true, 'still subscribed');
  });
});

describe('conversationMessages: storing events', () => {
  it('drops an event when the receiving identity holds no subscription', async () => {
    const store = new InMemoryConversationMessageStore();
    const f = hubFixture(store);
    assert.equal(await f.hub.ingest(messageEvent()), undefined);
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    // N bots in one chat deliver N copies: only the subscribed identity's is stored.
    assert.equal(await f.hub.ingest(messageEvent({ receivedByChannelKey: NORA_KEY })), undefined);
    assert.equal(await f.hub.ingest(messageEvent({ conversationId: '19:other@thread.v2' })), undefined);
    assert.deepEqual((await f.hub.listSince(scopeOf('mara'), ENGINE)).events, []);
  });

  it('stores the platform-stated author and derives the principal', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    const record = await f.hub.ingest(
      messageEvent({ receivedByChannelKey: MARA_KEY.toUpperCase(), replyToMessageId: 'm0', quoted: true }),
    );
    assert.ok(record);
    assert.deepEqual(record.author, {
      kind: 'teams-aad',
      id: 'AAD-Anna',
      displayName: 'Anna Köhler',
      principalId: 'user:aad-anna',
    });
    assert.equal(record.revision, 0);
    assert.equal(record.kind, 'created');
    assert.equal(record.receivedByChannelKey, MARA_KEY.toLowerCase());
    assert.equal(record.tenantId, 'tenant-1');
    assert.equal(record.replyToMessageId, 'm0');
    assert.equal(record.quoted, true);
    assert.equal(record.forwarded, undefined);
    assert.deepEqual(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1'), record);
    assert.deepEqual(await f.hub.getEventById(scopeOf('mara'), ENGINE, record.eventId), record);
  });

  it('assigns revisions itself: an adapter that restarts at 1 cannot rewind them', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    await f.hub.ingest(messageEvent());
    const first = await f.hub.ingest(messageEvent({ kind: 'edited', revision: 1, text: 'A > B > C' }));
    const second = await f.hub.ingest(messageEvent({ kind: 'edited', revision: 2, text: 'B > A > C' }));
    // Middleware restart: the adapter's in-memory counter starts again at 1.
    const afterRestart = await f.hub.ingest(messageEvent({ kind: 'edited', revision: 1, text: 'C > A > B' }));
    const deleted = await f.hub.ingest(messageEvent({ kind: 'deleted', revision: 1, text: 'ignored' }));
    assert.deepEqual(
      [first, second, afterRestart, deleted].map((r) => r?.revision),
      [1, 2, 3, 4],
    );
    assert.equal(deleted?.text, undefined, 'a deletion carries no text');
    const latest = await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1');
    assert.equal(latest?.kind, 'deleted');
    assert.equal((await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1', 2))?.text, 'B > A > C');
    assert.equal(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1', 9), undefined);
  });

  it('revision rule', () => {
    assert.equal(assignRevision('created', undefined, 7), 0);
    assert.equal(assignRevision('edited', undefined, undefined), 1, 'an edit is never "the original"');
    assert.equal(assignRevision('edited', 0, 1), 1);
    assert.equal(assignRevision('edited', 4, 1), 5);
    assert.equal(assignRevision('edited', 1, 6), 6, 'the adapter may be ahead when the kernel missed edits');
    assert.equal(assignRevision('deleted', 2, 9), 3);
    assert.equal(assignRevision('reaction', 2, undefined), 2);
    assert.equal(assignRevision('card_answer', undefined, undefined), 0);
  });

  it('a redelivered platform event is stored once', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    const original = messageEvent();
    assert.ok(await f.hub.ingest(original));
    // A mentioned message is emitted and also starts a turn; a retry delivers it again.
    assert.equal(await f.hub.ingest({ ...original }), undefined);
    assert.equal(await f.hub.ingest(messageEvent({ occurredAt: '2026-11-18T10:00:00.000Z' })), undefined);
    const edit = messageEvent({ kind: 'edited', text: 'B' });
    assert.ok(await f.hub.ingest(edit));
    assert.equal(await f.hub.ingest({ ...edit }), undefined);
    assert.equal((await f.hub.listSince(scopeOf('mara'), ENGINE)).events.length, 2);
  });

  it('stores reactions and card answers against the message, not as revisions', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    await f.hub.ingest(messageEvent());
    await f.hub.ingest(messageEvent({ kind: 'edited', text: 'B' }));
    const reaction = await f.hub.ingest(
      messageEvent({ kind: 'reaction', text: undefined, reaction: { name: 'like', removed: false } }),
    );
    const answer = await f.hub.ingest(
      messageEvent({
        kind: 'card_answer',
        messageId: 'card-1',
        text: undefined,
        author: { kind: 'teams-aad', id: 'aad-ben' },
        cardAnswer: { cardId: 'poll-7', value: { optionId: 'b' } },
      }),
    );
    const changed = await f.hub.ingest(
      messageEvent({
        kind: 'card_answer',
        messageId: 'card-1',
        text: undefined,
        author: { kind: 'teams-aad', id: 'aad-ben' },
        cardAnswer: { cardId: 'poll-7', value: { optionId: 'c' } },
      }),
    );
    assert.deepEqual(reaction?.reaction, { name: 'like', removed: false });
    assert.equal(reaction?.revision, 1, 'refers to the revision it reacted to');
    assert.deepEqual(answer?.cardAnswer, { cardId: 'poll-7', value: { optionId: 'b' } });
    assert.ok(changed, 'a changed answer is a second event; the engine decides which counts');
    assert.equal((await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1'))?.kind, 'edited');
    assert.equal(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'card-1'), undefined);
  });

  it('drops malformed events without throwing', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    for (const bad of [
      messageEvent({ messageId: '' }),
      messageEvent({ kind: 'typing' as never }),
      messageEvent({ author: { kind: 'teams-aad', id: '' } }),
      messageEvent({ occurredAt: 'yesterday' }),
      messageEvent({ kind: 'reaction', reaction: undefined }),
      messageEvent({ kind: 'card_answer', cardAnswer: undefined }),
    ]) {
      assert.equal(await f.hub.ingest(bad), undefined);
    }
    assert.doesNotThrow(() => f.hub.emit(null as never));
    assert.equal(f.logs.filter((l) => /dropped an invalid event/.test(l)).length, 7);
  });

  it('keeps arrival order per subscription', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    const all = await Promise.all([
      f.hub.ingest(messageEvent({ messageId: 'a' })),
      f.hub.ingest(messageEvent({ messageId: 'a', kind: 'edited', text: 'x' })),
      f.hub.ingest(messageEvent({ messageId: 'b' })),
    ]);
    assert.deepEqual(all.map((r) => `${r!.messageId}:${String(r!.revision)}`), ['a:0', 'a:1', 'b:0']);
    const page = await f.hub.listSince(scopeOf('mara'), ENGINE);
    assert.deepEqual(page.events.map((e) => e.eventId), all.map((r) => r!.eventId));
  });
});

describe('conversationMessages: reading', () => {
  it('getEvent knows nothing of a foreign conversation or of a message from before the subscription', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    // Before the subscription: emitted, never stored.
    await f.hub.ingest(messageEvent({ messageId: 'early' }));
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    await f.hub.subscribe(scopeOf('nora', '19:other@thread.v2'), ENGINE);
    await f.hub.ingest(messageEvent({ messageId: 'm1' }));
    await f.hub.ingest(
      messageEvent({ messageId: 'x1', conversationId: '19:other@thread.v2', receivedByChannelKey: NORA_KEY }),
    );
    assert.equal(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'early'), undefined);
    assert.equal(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'x1'), undefined, 'foreign conversation');
    assert.equal(await f.hub.getEvent(scopeOf('nora'), ENGINE, 'm1'), undefined, 'nora is not subscribed there');
    assert.equal(await f.hub.getEvent(scopeOf('mara', '19:other@thread.v2'), ENGINE, 'x1'), undefined);
    assert.equal(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'nope'), undefined);
    assert.ok(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1'));
    assert.ok(await f.hub.getEvent(scopeOf('nora', '19:other@thread.v2'), ENGINE, 'x1'));
  });

  it('a new subscription does not see what an earlier one received', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    await f.hub.ingest(messageEvent({ messageId: 'old-vote' }));
    await f.hub.unsubscribe(scopeOf('mara'), ENGINE);
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false, 'the mention gate applies again at once');
    assert.equal(await f.hub.ingest(messageEvent({ messageId: 'between' })), undefined);
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    assert.equal(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'old-vote'), undefined);
    assert.deepEqual((await f.hub.listSince(scopeOf('mara'), ENGINE)).events, []);
  });

  it('listSince replays strictly after the cursor and omits nextCursor at the end', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    for (const id of ['a', 'b', 'c', 'd', 'e']) await f.hub.ingest(messageEvent({ messageId: id }));
    const first = await f.hub.listSince(scopeOf('mara'), ENGINE, { limit: 2 });
    assert.deepEqual(first.events.map((e) => e.messageId), ['a', 'b']);
    assert.equal(first.nextCursor, first.events[1]!.eventId);
    const second = await f.hub.listSince(scopeOf('mara'), ENGINE, { after: first.nextCursor!, limit: 2 });
    assert.deepEqual(second.events.map((e) => e.messageId), ['c', 'd']);
    const third = await f.hub.listSince(scopeOf('mara'), ENGINE, { after: second.nextCursor!, limit: 2 });
    assert.deepEqual(third.events.map((e) => e.messageId), ['e']);
    assert.equal(third.nextCursor, undefined);
    // A page that ends exactly at the end has no cursor either.
    const exact = await f.hub.listSince(scopeOf('mara'), ENGINE, { after: first.nextCursor!, limit: 3 });
    assert.equal(exact.events.length, 3);
    assert.equal(exact.nextCursor, undefined);
    assert.deepEqual(
      (await f.hub.listSince(scopeOf('mara'), ENGINE, { after: third.events[0]!.eventId })).events,
      [],
    );
  });

  it('delivers live, at least once, and survives a failing handler', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    const seen: ConversationMessageRecord[] = [];
    f.hub.onMessage('mara', ENGINE, () => {
      throw new Error('engine hiccup');
    });
    const dispose = f.hub.onMessage('mara', ENGINE, (r) => void seen.push(r));
    const foreign: ConversationMessageRecord[] = [];
    f.hub.onMessage('mara', '@acme/snoop', (r) => void foreign.push(r));
    f.hub.onMessage('nora', ENGINE, (r) => void foreign.push(r));
    f.hub.emit(messageEvent());
    await flush();
    await flush();
    assert.equal(seen.length, 1);
    assert.equal(foreign.length, 0);
    assert.ok(f.logs.some((l) => /live handler for 'mara' failed on event/.test(l)));
    // The failed consumer catches up through the replay.
    assert.equal((await f.hub.listSince(scopeOf('mara'), ENGINE)).events.length, 1);
    dispose();
    f.hub.emit(messageEvent({ messageId: 'm2' }));
    await flush();
    await flush();
    assert.equal(seen.length, 1);
  });
});

describe('conversationMessages: plugin-facing service', () => {
  it('answers only the facilitation engine', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    let engine = true;
    const forEngine = createConversationMessagesService({ hub: f.hub, callerPluginId: ENGINE, isEngine: () => engine });
    const forOther = createConversationMessagesService({ hub: f.hub, callerPluginId: '@acme/crm', isEngine: () => false });
    const refused = await forOther.subscribe(scopeOf('mara'));
    assert.equal(refused.outcome === 'refused' && refused.code, 'unavailable');
    assert.match(refused.outcome === 'refused' ? refused.message : '', /only the facilitation engine plugin/);

    assert.deepEqual(await forEngine.subscribe(scopeOf('mara')), { outcome: 'subscribed' });
    await f.hub.ingest(messageEvent());
    assert.equal((await forEngine.getEvent(scopeOf('mara'), 'm1'))?.author.id, 'AAD-Anna');
    assert.equal(await forOther.getEvent(scopeOf('mara'), 'm1'), undefined);
    assert.deepEqual(await forOther.listSince(scopeOf('mara')), { events: [] });
    await forOther.unsubscribe(scopeOf('mara'));
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), true);

    // The plugin stops being the engine (uninstalled, replaced): nothing more.
    engine = false;
    assert.equal(await forEngine.getEvent(scopeOf('mara'), 'm1'), undefined);
    engine = true;
    await forEngine.unsubscribe(scopeOf('mara'));
    assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
  });
});

describe('conversationMessages: CoreApi and retention', () => {
  const baseOptions = { dispatcher: {} as never, routes: {} as never };

  it('CoreApi exposes emit and the synchronous lookup only when wired', async () => {
    assert.equal(createCoreApi(baseOptions).emitConversationMessage, undefined);
    assert.equal(createCoreApi(baseOptions).isAllMessagesSubscribed, undefined);
    const f = hubFixture(new InMemoryConversationMessageStore());
    const api = createCoreApi({ ...baseOptions, conversationMessages: f.hub });
    assert.equal(api.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY), false);
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    assert.equal(api.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY.toLowerCase()), true);
    assert.equal(api.isAllMessagesSubscribed!(undefined as never, CONVERSATION, MARA_KEY), false, 'never throws');
    api.emitConversationMessage!(messageEvent());
    await flush();
    assert.equal((await f.hub.listSince(scopeOf('mara'), ENGINE)).events.length, 1);
    const throwing = createCoreApi({
      ...baseOptions,
      conversationMessages: {
        emit: () => undefined,
        isSubscribed: () => {
          throw new Error('boom');
        },
      },
    });
    assert.equal(throwing.isAllMessagesSubscribed!('teams', CONVERSATION, MARA_KEY), false);
  });

  it('purges only after the subscription ended plus the grace period, and by age', async () => {
    let now = Date.parse('2026-11-18T09:00:00.000Z');
    const store = new InMemoryConversationMessageStore(() => new Date(now));
    const f = hubFixture(store);
    const HOUR = 60 * 60 * 1000;
    const job = startConversationMessagePurge(store, f.hub, {
      graceMs: 6 * HOUR,
      maxAgeDays: 30,
      intervalMs: 3_600_000,
      now: () => now,
      log: (m) => f.logs.push(m),
    });
    try {
      await f.hub.subscribe(scopeOf('mara'), ENGINE);
      await f.hub.ingest(messageEvent());
      now += 20 * 24 * HOUR; // a long facilitation: still subscribed, nothing goes
      await job.tick();
      assert.equal((await f.hub.listSince(scopeOf('mara'), ENGINE)).events.length, 1);

      await f.hub.ingest(messageEvent({ messageId: 'm2' }));
      now += 11 * 24 * HOUR; // the first event is now older than the maximum age
      await job.tick();
      assert.deepEqual(
        (await f.hub.listSince(scopeOf('mara'), ENGINE)).events.map((e) => e.messageId),
        ['m2'],
      );

      await f.hub.unsubscribe(scopeOf('mara'), ENGINE);
      now += 5 * HOUR; // inside the grace period
      assert.deepEqual(await store.purge({ endedBefore: new Date(now - 6 * HOUR) }), { events: 0, subscriptions: 0 });
      now += 2 * HOUR;
      await job.tick();
      assert.ok(f.logs.some((l) => /purged 1 event\(s\) of 1 ended subscription\(s\)/.test(l)));
    } finally {
      job.stop();
    }
  });

  it('presence: per-bot references decide, the invite index is the fallback', async () => {
    const invites = { get: (_t: string, c: string) => (c === 'invited' ? ({} as never) : undefined) };
    const withRefs = createBotPresenceCheck({
      invites,
      botPresence: { botAppIdsIn: (c) => Promise.resolve(c === 'empty' || c === 'invited' ? [] : ['aaaa-mara']) },
    });
    assert.equal(await withRefs('teams', 'chat', '28:AAAA-MARA'), true);
    assert.equal(await withRefs('teams', 'chat', '28:bbbb-nora'), false, 'another bot is there, this one is not');
    assert.equal(await withRefs('teams', 'empty', '28:aaaa-mara'), false);
    assert.equal(await withRefs('teams', 'invited', '28:aaaa-mara'), true, 'no references: invite index');
    assert.equal(await createBotPresenceCheck({ invites })('slack', 'invited', 'B1'), true);
    assert.equal(principalOfChannelUser({ id: 'AAD-Anna' }), 'user:aad-anna');
  });
});
