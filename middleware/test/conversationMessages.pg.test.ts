/**
 * 'conversationMessages@2' against a real Postgres (#2043, #2089; migrations
 * 0068 and 0075).
 *
 * What only the database can prove: the record survives a restart (a new hub
 * over the same tables replays from a cursor and keeps counting revisions
 * where it stopped), a redelivery and a concurrent edit cannot produce two
 * records, an identity holds one subscription per process in a conversation,
 * and the retention job removes exactly what ended.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { PgConversationMessageStore } from '../src/channels/conversationMessages/pgStore.js';
import {
  CONVERSATION,
  DEFAULT_AGENTS,
  ENGINE,
  FULL_ACCESS,
  hubFixture,
  MARA_KEY,
  messageEvent,
  NORA_KEY,
  processOf,
  readAll,
} from './_helpers/conversationMessagesFixture.js';
import { probePgTest } from './_helpers/pgTestDb.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'conversationMessages',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `conv_messages_${String(process.pid)}`;
const OTHER_CHAT = '19:other@thread.v2';
/** The process of the engine that reads the conversation for mara. */
const MARA_PROCESS = processOf('mara');
const SUBSCRIBED = { outcome: 'subscribed', mode: 'all' };

describe('conversationMessages (pg, migrations 0068 and 0075)', { skip: !pgAvailable }, () => {
  let pool: Pool;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${SCHEMA},public` });
    for (const file of [
      '0001_multi_orchestrator.sql',
      '0002_fix_notify_trigger.sql',
      '0067_agent_kind.sql',
      '0068_conversation_messages.sql',
      '0070_agent_archetypes.sql',
      // #2089 — process-bound subscriptions; the store reads the new columns.
      '0075_process_bound_messages.sql',
      '0077_transcript_segments.sql',
    ]) {
      const sql = await readFile(resolve(MIGRATIONS_DIR, file), 'utf8');
      await pool.query(sql);
      await pool.query(sql);
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM agents');
    for (const agent of DEFAULT_AGENTS) {
      await pool.query('INSERT INTO agents (id, slug, name, archetype) VALUES ($1, $2, $2, $3)', [
        agent.id,
        agent.slug,
        agent.archetype,
      ]);
    }
  });

  /** A fresh hub over the same tables: what a process restart looks like. */
  async function boot(): Promise<ReturnType<typeof hubFixture>> {
    const fixture = hubFixture(new PgConversationMessageStore(pool));
    await fixture.hub.refresh();
    return fixture;
  }

  it('stores events with kernel revisions and the platform author', async () => {
    const f = await boot();
    assert.deepEqual(await readAll(f, 'mara'), SUBSCRIBED);
    const created = await f.hub.ingest(messageEvent({ replyToMessageId: 'm0', forwarded: true }));
    const edited = await f.hub.ingest(messageEvent({ kind: 'edited', revision: 1, text: 'B > A' }));
    const reaction = await f.hub.ingest(
      messageEvent({ kind: 'reaction', text: undefined, reaction: { name: 'like', removed: false } }),
    );
    const answer = await f.hub.ingest(
      messageEvent({
        kind: 'card_answer',
        messageId: 'card-1',
        text: undefined,
        cardAnswer: { cardId: 'poll-7', value: { optionId: 'b' } },
      }),
    );
    assert.ok(created && edited && reaction && answer);
    assert.deepEqual(created.author, {
      kind: 'teams-aad',
      id: 'AAD-Anna',
      displayName: 'Anna Köhler',
      principalId: 'user:aad-anna',
    });
    assert.equal(created.forwarded, true);
    assert.equal(created.replyToMessageId, 'm0');
    assert.equal(created.receivedByChannelKey, MARA_KEY.toLowerCase());
    assert.deepEqual([created.revision, edited.revision, reaction.revision], [0, 1, 1]);
    assert.deepEqual(reaction.reaction, { name: 'like', removed: false });
    assert.deepEqual(answer.cardAnswer, { cardId: 'poll-7', value: { optionId: 'b' } });
    // #2089 — a question card's typed answer survives the store and the read.
    const typedAnswers = [
      { questionId: 'q1', kind: 'ranking' as const, ranking: ['c', 'a', 'b'] },
      { questionId: 'q2', kind: 'consent' as const, decision: 'object' as const, reason: 'Too early.' },
    ];
    const typed = await f.hub.ingest(
      messageEvent({
        kind: 'card_answer',
        messageId: 'card-2',
        text: undefined,
        cardAnswer: {
          cardId: 'c-17',
          value: { answers: typedAnswers },
          answererVerified: true,
          proposalId: 'p-4',
          proposalVersion: 2,
          answers: typedAnswers,
        },
      }),
    );
    assert.deepEqual(typed?.cardAnswer, {
      cardId: 'c-17',
      value: { answers: typedAnswers },
      answererVerified: true,
      proposalId: 'p-4',
      proposalVersion: 2,
      answers: typedAnswers,
    });
    const malformed = await f.hub.ingest(
      messageEvent({
        kind: 'card_answer',
        messageId: 'card-3',
        text: undefined,
        cardAnswer: { cardId: 'c-17', value: {}, answers: [{ questionId: 'q1', kind: 'ranking' }] as never },
      }),
    );
    assert.equal(malformed, undefined, 'an answer outside the contract is refused, not stored as something else');
    assert.match(created.eventId, /^\d+$/);
    assert.ok(Date.parse(created.receivedAt) > 0);
    // A read hands the stored record back with the process it belongs to.
    const ofProcess = <T extends object>(record: T) => ({ ...record, processId: MARA_PROCESS.processId });
    assert.deepEqual(await f.hub.getProcessEvent(MARA_PROCESS, ENGINE, 'm1'), ofProcess(edited));
    // #2089 — the earlier revision says it was superseded, and by which.
    assert.deepEqual(await f.hub.getProcessEvent(MARA_PROCESS, ENGINE, 'm1', 0), { ...ofProcess(created), superseded: true, latestRevision: 1 });
    assert.deepEqual(await f.hub.getProcessEventById(MARA_PROCESS, ENGINE, answer.eventId), ofProcess(answer));
    assert.equal(await f.hub.getProcessEventById(MARA_PROCESS, ENGINE, 'not-a-number'), undefined);
  });

  it('replays after a restart and keeps counting revisions', async () => {
    const before = await boot();
    await readAll(before, 'mara');
    await before.hub.ingest(messageEvent({ messageId: 'a' }));
    const seen = await before.hub.ingest(messageEvent({ messageId: 'a', kind: 'edited', revision: 1, text: 'v1' }));
    await before.hub.ingest(messageEvent({ messageId: 'b' }));
    assert.ok(seen);

    // Restart: no in-memory state, the adapter's edit counter is back at 1.
    const restarted = await boot();
    assert.equal(restarted.hub.isSubscribed('teams', CONVERSATION, MARA_KEY.toLowerCase()), true);
    assert.equal(restarted.hub.isSubscribed('teams', CONVERSATION, NORA_KEY), false);
    const page = await restarted.hub.listProcessEventsSince(MARA_PROCESS, ENGINE, { after: seen.eventId });
    assert.deepEqual(page.events.map((e) => e.messageId), ['b']);
    assert.equal(page.nextCursor, undefined);
    const next = await restarted.hub.ingest(messageEvent({ messageId: 'a', kind: 'edited', revision: 1, text: 'v2' }));
    assert.equal(next?.revision, 2, 'not rewound to 1');
    const all = await restarted.hub.listProcessEventsSince(MARA_PROCESS, ENGINE, { limit: 2 });
    assert.equal(all.events.length, 2);
    assert.equal(all.nextCursor, all.events[1]!.eventId);
    // The subscribe is still idempotent after the restart.
    assert.deepEqual(await readAll(restarted, 'mara'), SUBSCRIBED);
    const { rows } = await pool.query('SELECT 1 FROM conversation_message_subscriptions');
    assert.equal(rows.length, 1);
  });

  it('stores a redelivery once and survives concurrent edits', async () => {
    const f = await boot();
    await readAll(f, 'mara');
    const store = new PgConversationMessageStore(pool);
    const [subscription] = await store.listActiveSubscriptions();
    assert.ok(subscription);
    const original = messageEvent();
    assert.ok(await f.hub.ingest(original));
    assert.equal(await f.hub.ingest({ ...original }), undefined);
    assert.equal(await f.hub.ingest(messageEvent({ text: 'same id, later delivery' })), undefined);

    // Two machines storing different edits of one message at the same time:
    // the store is called directly, without the per-process queue.
    const edits = await Promise.all(
      ['x', 'y', 'z'].map((text) =>
        store.insertEvent(subscription, {
          messageId: 'm1',
          kind: 'edited',
          author: { kind: 'teams-aad', id: 'AAD-Anna' },
          text,
          occurredAt: new Date(Date.parse('2026-11-18T12:00:00Z') + text.charCodeAt(0)).toISOString(),
        }),
      ),
    );
    assert.deepEqual(edits.map((e) => e?.revision).sort(), [1, 2, 3]);
  });

  it('getEvent is blind to foreign conversations and to an earlier process', async () => {
    const f = await boot();
    await f.hub.ingest(messageEvent({ messageId: 'early' }));
    await readAll(f, 'mara');
    await readAll(f, 'nora', OTHER_CHAT);
    await f.hub.ingest(messageEvent({ messageId: 'm1' }));
    await f.hub.ingest(
      messageEvent({ messageId: 'x1', conversationId: '19:other@thread.v2', receivedByChannelKey: NORA_KEY }),
    );
    // Two bots in one chat: nora's copy of the same message is not stored.
    assert.equal(await f.hub.ingest(messageEvent({ messageId: 'm1', receivedByChannelKey: NORA_KEY })), undefined);
    assert.equal(await f.hub.getProcessEvent(MARA_PROCESS, ENGINE, 'early'), undefined);
    assert.equal(await f.hub.getProcessEvent(MARA_PROCESS, ENGINE, 'x1'), undefined);
    assert.equal(await f.hub.getProcessEvent(MARA_PROCESS, '@acme/snoop', 'm1'), undefined);
    assert.ok(await f.hub.getProcessEvent(MARA_PROCESS, ENGINE, 'm1'));

    // The process is over (no open scope): the kernel ends its subscription.
    // A later process of the same agent in the same conversation starts empty.
    f.access.set(`${ENGINE}|${MARA_PROCESS.processId}`, { reserved: false, everReserved: true, openScope: false });
    assert.equal((await f.hub.reconcile()).length, 1);
    const later = processOf('mara', CONVERSATION, 'a-later-process');
    f.access.set(`${ENGINE}|${later.processId}`, FULL_ACCESS);
    assert.deepEqual(await f.hub.subscribeProcess(later, 'all', ENGINE), SUBSCRIBED);
    assert.equal(await f.hub.getProcessEvent(later, ENGINE, 'm1'), undefined, 'a new subscription starts empty');
    assert.equal(await f.hub.getProcessEvent(MARA_PROCESS, ENGINE, 'm1'), undefined, 'and reads of the ended one are over');
    const rows = await pool.query<{ active: boolean }>(
      `SELECT ended_at IS NULL AS active FROM conversation_message_subscriptions
        WHERE agent_slug = 'mara' ORDER BY created_at`,
    );
    assert.deepEqual(rows.rows.map((r) => r.active), [false, true]);
  });

  it('stores the identity lower-cased, and the table refuses anything else', async () => {
    const store = new PgConversationMessageStore(pool);
    const input = {
      agentId: DEFAULT_AGENTS[0]!.id,
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: CONVERSATION,
      channelKey: MARA_KEY,
      pluginId: ENGINE,
      processId: 'f1',
      mode: 'all' as const,
    };
    const first = await store.createProcessSubscription(input);
    const again = await store.createProcessSubscription({ ...input, channelKey: MARA_KEY.toUpperCase() });
    assert.deepEqual([again.existed, again.subscription.id], [true, first.subscription.id]);
    assert.equal(first.subscription.channelKey, MARA_KEY.toLowerCase());
    await assert.rejects(
      pool.query(
        `INSERT INTO conversation_message_subscriptions
           (agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id, process_id)
         VALUES ($1, 'mara', 'teams', 'c2', '28:UPPER', $2, 'f2')`,
        [input.agentId, ENGINE],
      ),
      (err: { code?: string }) => err.code === '23514',
    );
  });

  it('purges after the grace period, not by age while the process runs, and with the agent', async () => {
    const f = await boot();
    const store = new PgConversationMessageStore(pool);
    await readAll(f, 'mara');
    await readAll(f, 'nora');
    await f.hub.ingest(messageEvent());
    await f.hub.ingest(messageEvent({ messageId: 'm2' }));
    await f.hub.ingest(messageEvent({ receivedByChannelKey: NORA_KEY }));
    const count = async (): Promise<number> =>
      Number((await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM conversation_message_events')).rows[0]!.n);
    assert.equal(await count(), 3);

    // Still subscribed: nothing goes, however long ago the cut-off is set.
    assert.deepEqual(await store.purge({ endedBefore: new Date(Date.now() + 60_000) }), { events: 0, subscriptions: 0 });

    await f.hub.endAllOf('mara', 'agent disabled');
    // Inside the grace period: kept.
    assert.deepEqual(await store.purge({ endedBefore: new Date(Date.now() - 60_000) }), { events: 0, subscriptions: 0 });
    // Grace period over: mara's two events and the ended row go, nora's stays.
    assert.deepEqual(await store.purge({ endedBefore: new Date(Date.now() + 60_000) }), { events: 2, subscriptions: 1 });
    assert.equal(await count(), 1);

    // The maximum age does not take what a running process received: its
    // scopes bound how long it lives, not the calendar.
    await pool.query(`UPDATE conversation_message_events SET received_at = now() - interval '31 days'`);
    const aged = await store.purge({
      endedBefore: new Date(0),
      receivedBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    assert.deepEqual(aged, { events: 0, subscriptions: 0 });
    assert.equal(await count(), 1);

    // Deleting the agent removes its subscription and whatever it received.
    await f.hub.ingest(messageEvent({ messageId: 'm9', receivedByChannelKey: NORA_KEY }));
    assert.equal(await count(), 2);
    await pool.query(`DELETE FROM agents WHERE slug = 'nora'`);
    assert.equal(await count(), 0);
    assert.deepEqual(await store.listActiveSubscriptions(), []);
  });

  it('wakes the listeners for a real change only, once per statement', async () => {
    const f = await boot();
    const listener = await pool.connect();
    const seen: string[] = [];
    listener.on('notification', (msg) => seen.push(msg.channel));
    try {
      await listener.query('LISTEN conversation_message_subscriptions_changed');
      // What the purge job runs on every tick with nothing to purge.
      await pool.query(`DELETE FROM conversation_message_subscriptions WHERE ended_at < now() - interval '100 years'`);
      await pool.query(`UPDATE conversation_message_subscriptions SET ended_at = ended_at WHERE false`);
      await listener.query('SELECT 1');
      assert.deepEqual(seen, [], 'a statement that touched no row wakes nobody');

      assert.deepEqual(await readAll(f, 'mara'), SUBSCRIBED);
      assert.deepEqual(await readAll(f, 'nora'), SUBSCRIBED);
      await listener.query('SELECT 1');
      assert.equal(seen.length, 2, 'one wake-up per subscription written');
      seen.length = 0;
      await pool.query('UPDATE conversation_message_subscriptions SET ended_at = now()');
      await listener.query('SELECT 1');
      assert.equal(seen.length, 1, 'one statement over two rows wakes the listeners once');
    } finally {
      listener.release(true);
    }
  });

  describe('#2089 process subscriptions (migration 0075)', () => {
    const MARA = DEFAULT_AGENTS[0]!;
    const base = {
      agentId: MARA.id,
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: CONVERSATION,
      channelKey: MARA_KEY,
      pluginId: ENGINE,
    };
    const event = (messageId: string) => ({
      messageId,
      kind: 'created' as const,
      author: { kind: 'teams-aad', id: 'AAD-Anna' },
      text: messageId,
      occurredAt: new Date().toISOString(),
    });

    it('one identity holds one row per process in a conversation; a process subscribes it once', async () => {
      const store = new PgConversationMessageStore(pool);
      const f1 = await store.createProcessSubscription({ ...base, processId: 'f1', mode: 'addressed' });
      const f2 = await store.createProcessSubscription({ ...base, processId: 'f2', mode: 'all' });
      assert.deepEqual([f1.existed, f2.existed, f1.subscription.mode, f2.subscription.processId], [false, false, 'addressed', 'f2']);
      assert.notEqual(f1.subscription.id, f2.subscription.id);
      const again = await store.createProcessSubscription({ ...base, processId: 'f1', mode: 'all' });
      assert.deepEqual([again.existed, again.ended, again.subscription.id, again.subscription.mode], [true, false, f1.subscription.id, 'addressed']);
      assert.equal((await store.listActiveSubscriptions()).length, 2);

      assert.equal((await store.setSubscriptionMode(f1.subscription.id, 'none'))?.mode, 'none');
      await store.endSubscription(f1.subscription.id);
      assert.equal(await store.setSubscriptionMode(f1.subscription.id, 'all'), undefined, 'ended');
      const ended = await store.createProcessSubscription({ ...base, processId: 'f1', mode: 'all' });
      assert.deepEqual([ended.existed, ended.ended], [true, true], 'never re-opened');
      // A subscription without a process cannot carry a mode other than all.
      await assert.rejects(
        pool.query(
          `INSERT INTO conversation_message_subscriptions (agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id, mode)
           VALUES ($1, 'mara', 'teams', 'c-x', '28:k', $2, 'addressed')`,
          [MARA.id, ENGINE],
        ),
        (err: { constraint?: string }) => err.constraint === 'conversation_message_subscriptions_mode_check',
      );
    });

    it('each process reads only its own row\'s events', async () => {
      const store = new PgConversationMessageStore(pool);
      const f1 = (await store.createProcessSubscription({ ...base, processId: 'f1', mode: 'all' })).subscription;
      const f2 = (await store.createProcessSubscription({ ...base, processId: 'f2', mode: 'all' })).subscription;
      await store.insertEvent(f1, event('m1'));
      await store.insertEvent(f2, { ...event('m2'), addressedToBot: true });
      assert.deepEqual((await store.listSince(f1, undefined, 10)).map((e) => e.messageId), ['m1']);
      const second = await store.listSince(f2, undefined, 10);
      assert.deepEqual(second.map((e) => [e.messageId, e.addressedToBot]), [['m2', true]]);
      assert.equal(await store.getEvent(f2, 'm1'), undefined);
    });

    it('the first binding of a message or card stands', async () => {
      const store = new PgConversationMessageStore(pool);
      const bind = (ref: string, processId: string): Promise<boolean> =>
        store.bindProcessMessage({ channelType: 'teams', conversationId: CONVERSATION, ref, agentId: MARA.id, pluginId: ENGINE, processId });
      assert.equal(await bind('reminder-1', 'f1'), true);
      assert.equal(await bind('reminder-1', 'f1'), true);
      assert.equal(await bind('reminder-1', 'f2'), false);
      assert.equal(await bind('card:c1', 'f2'), true);
      assert.deepEqual(
        [...(await store.findProcessBindings('teams', CONVERSATION, ['reminder-1', 'card:c1', 'unknown']))].sort((a, b) => a.ref.localeCompare(b.ref)),
        [
          { ref: 'card:c1', pluginId: ENGINE, processId: 'f2' },
          { ref: 'reminder-1', pluginId: ENGINE, processId: 'f1' },
        ],
      );
      assert.deepEqual(await store.findProcessBindings('teams', '19:elsewhere', ['reminder-1']), []);
    });

    it('#2089 transcript segments: revisions per segment, apart from a message with the same id', async () => {
      const store = new PgConversationMessageStore(pool);
      const f1 = (await store.createProcessSubscription({ ...base, processId: 'f1', mode: 'all' })).subscription;
      const transcript = { sessionId: 'session-3', segmentId: 'seg-1', source: 'shared' as const, speakerHint: 'Bert?' };
      const seg = (text: string) => ({
        messageId: 'seg-1',
        kind: 'transcript_segment' as const,
        author: { kind: 'custom', id: 'media:room-mic-2' },
        text,
        transcript,
        occurredAt: new Date().toISOString(),
      });
      const first = await store.insertEvent(f1, seg('option B'));
      const redelivered = await store.insertEvent(f1, seg('option B'));
      const corrected = await store.insertEvent(f1, seg('option D'));
      const message = await store.insertEvent(f1, event('seg-1'));
      assert.deepEqual([first?.revision, redelivered, corrected?.revision, message?.revision], [0, undefined, 1, 0]);
      const read = await store.getEventById(f1, corrected!.eventId);
      assert.deepEqual([read?.kind, read?.text, read?.transcript], ['transcript_segment', 'option D', transcript]);
      // Two workers storing two corrections at once: both are kept, in order.
      const raced = await Promise.all([store.insertEvent(f1, seg('option E')), store.insertEvent(f1, seg('option F'))]);
      assert.deepEqual(raced.map((r) => r?.revision).sort(), [2, 3]);
    });

    it('the age limit spares a running process and applies as soon as its subscription ended', async () => {
      const store = new PgConversationMessageStore(pool);
      const f1 = (await store.createProcessSubscription({ ...base, processId: 'f1', mode: 'all' })).subscription;
      const f2 = (await store.createProcessSubscription({ ...base, processId: 'f2', mode: 'addressed' })).subscription;
      await store.insertEvent(f1, event('m1'));
      await store.insertEvent(f2, event('m2'));
      await store.endSubscription(f2.id);
      await pool.query("UPDATE conversation_message_events SET received_at = now() - interval '40 days'");
      // Ended a moment ago, so still inside the grace period: it is the age
      // that takes the old event of the ended subscription.
      const cutoffs = { endedBefore: new Date(Date.now() - 6 * 3_600_000), receivedBefore: new Date(Date.now() - 30 * 24 * 3_600_000) };
      assert.deepEqual(await store.purge(cutoffs), { events: 1, subscriptions: 0 });
      assert.deepEqual((await store.listSince(f1, undefined, 10)).map((e) => e.messageId), ['m1']);
      assert.deepEqual(await store.listSince(f2, undefined, 10), []);
    });

    it('a row without a process (the form before migration 0080) is not an active subscription', async () => {
      // What 0080 ends. Should one still be active, nobody reads through it,
      // so it must not lift the channel's mention gate either.
      await pool.query(
        `INSERT INTO conversation_message_subscriptions (agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id)
         VALUES ($1, 'mara', 'teams', $2, $3, $4)`,
        [MARA.id, CONVERSATION, MARA_KEY.toLowerCase(), ENGINE],
      );
      assert.deepEqual(await new PgConversationMessageStore(pool).listActiveSubscriptions(), []);
      const f = await boot();
      assert.equal(f.hub.isSubscribed('teams', CONVERSATION, MARA_KEY), false);
      assert.equal(await f.hub.ingest(messageEvent()), undefined);
    });
  });

  it('#2067 (K6.3) migration 0080 ends every active subscription without a process, and no other', async () => {
    const mara = DEFAULT_AGENTS.find((a) => a.slug === 'mara')!;
    const insert = (conversationId: string, processId: string | null, mode: string, ended: boolean): Promise<unknown> =>
      pool.query(
        `INSERT INTO conversation_message_subscriptions
           (agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id, process_id, mode, ended_at)
         VALUES ($1, 'mara', 'teams', $2, $3, $4, $5, $6, CASE WHEN $7 THEN now() - interval '1 hour' ELSE NULL END)`,
        [mara.id, conversationId, MARA_KEY.toLowerCase(), ENGINE, processId, mode, ended],
      );
    await insert('k6-first-major', null, 'all', false);
    await insert('k6-first-major-ended', null, 'all', true);
    await insert('k6-process', 'fac-1', 'all', false);
    await insert('k6-process-addressed', 'fac-2', 'addressed', false);

    const sql = await readFile(resolve(MIGRATIONS_DIR, '0080_end_first_major_subscriptions.sql'), 'utf8');
    await pool.query(sql);
    const state = async (): Promise<Record<string, string>> =>
      Object.fromEntries(
        (
          await pool.query<{ conversation_id: string; state: string }>(
            `SELECT conversation_id,
                    CASE WHEN ended_at IS NULL THEN 'active'
                         WHEN ended_at > now() - interval '1 minute' THEN 'ended now' ELSE 'ended before' END AS state
               FROM conversation_message_subscriptions WHERE conversation_id LIKE 'k6-%'`,
          )
        ).rows.map((r) => [r.conversation_id, r.state]),
      );
    const expected = {
      'k6-first-major': 'ended now',
      'k6-first-major-ended': 'ended before',
      'k6-process': 'active',
      'k6-process-addressed': 'active',
    };
    assert.deepEqual(await state(), expected);
    await pool.query(sql); // idempotent
    assert.deepEqual(await state(), expected);
  });
});
