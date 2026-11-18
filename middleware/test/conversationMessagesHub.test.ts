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

import {
  assignRevision,
  InMemoryConversationMessageStore,
} from '../src/channels/conversationMessages/store.js';
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

  it('refuses a channel that never declared delivery of all messages', async () => {
    // Without a readiness provider a subscription would silence every mention
    // (the kernel suppresses the turn) while no message event ever arrives.
    const undeclared = hubFixture(new InMemoryConversationMessageStore());
    undeclared.hasReadinessProvider = false;
    const outcome = await undeclared.hub.subscribe(scopeOf('mara'), ENGINE);
    assert.equal(outcome.outcome === 'refused' && outcome.code, 'not_ready');
    assert.match(outcome.outcome === 'refused' ? outcome.message : '', /does not declare delivery of all messages/);
    assert.equal(undeclared.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
    undeclared.hasReadinessProvider = true;
    assert.equal((await undeclared.hub.subscribe(scopeOf('mara'), ENGINE)).outcome, 'subscribed');
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

describe('conversationMessages: adapter hints', () => {
  it('ignores an adapter revision outside a sane range instead of failing the insert', async () => {
    const f = hubFixture(new InMemoryConversationMessageStore());
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    await f.hub.ingest(messageEvent());
    for (const revision of [5_000_000_000, -3, 1.5, Number.NaN]) {
      const stored = await f.hub.ingest(messageEvent({ kind: 'edited', revision, text: `v${String(revision)}` }));
      assert.ok(stored, `revision ${String(revision)} must not drop the event`);
    }
    const latest = await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1');
    assert.equal(latest?.revision, 4, 'the kernel counted on its own');
  });
});
