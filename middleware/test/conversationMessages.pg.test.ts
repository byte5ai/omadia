/**
 * 'conversationMessages@1' against a real Postgres (#2043, migration 0068).
 *
 * What only the database can prove: the record survives a restart (a new hub
 * over the same tables replays from a cursor and keeps counting revisions
 * where it stopped), a redelivery and a concurrent edit cannot produce two
 * records, one identity holds one active subscription per conversation, and
 * the retention job removes exactly what ended.
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
  hubFixture,
  MARA_KEY,
  messageEvent,
  NORA_KEY,
  scopeOf,
} from './_helpers/conversationMessagesFixture.js';
import { probePgTest } from './_helpers/pgTestDb.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'conversationMessages',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const SCHEMA = `conv_messages_${String(process.pid)}`;

describe('conversationMessages (pg, migration 0068)', { skip: !pgAvailable }, () => {
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
      await pool.query('INSERT INTO agents (id, slug, name, kind) VALUES ($1, $2, $2, $3)', [
        agent.id,
        agent.slug,
        agent.kind,
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
    assert.deepEqual(await f.hub.subscribe(scopeOf('mara'), ENGINE), { outcome: 'subscribed' });
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
    assert.match(created.eventId, /^\d+$/);
    assert.ok(Date.parse(created.receivedAt) > 0);
    assert.deepEqual(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1'), edited);
    assert.deepEqual(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1', 0), created);
    assert.deepEqual(await f.hub.getEventById(scopeOf('mara'), ENGINE, answer.eventId), answer);
    assert.equal(await f.hub.getEventById(scopeOf('mara'), ENGINE, 'not-a-number'), undefined);
  });

  it('replays after a restart and keeps counting revisions', async () => {
    const before = await boot();
    await before.hub.subscribe(scopeOf('mara'), ENGINE);
    await before.hub.ingest(messageEvent({ messageId: 'a' }));
    const seen = await before.hub.ingest(messageEvent({ messageId: 'a', kind: 'edited', revision: 1, text: 'v1' }));
    await before.hub.ingest(messageEvent({ messageId: 'b' }));
    assert.ok(seen);

    // Restart: no in-memory state, the adapter's edit counter is back at 1.
    const restarted = await boot();
    assert.equal(restarted.hub.isSubscribed('teams', CONVERSATION, MARA_KEY.toLowerCase()), true);
    assert.equal(restarted.hub.isSubscribed('teams', CONVERSATION, NORA_KEY), false);
    const page = await restarted.hub.listSince(scopeOf('mara'), ENGINE, { after: seen.eventId });
    assert.deepEqual(page.events.map((e) => e.messageId), ['b']);
    assert.equal(page.nextCursor, undefined);
    const next = await restarted.hub.ingest(messageEvent({ messageId: 'a', kind: 'edited', revision: 1, text: 'v2' }));
    assert.equal(next?.revision, 2, 'not rewound to 1');
    const all = await restarted.hub.listSince(scopeOf('mara'), ENGINE, { limit: 2 });
    assert.equal(all.events.length, 2);
    assert.equal(all.nextCursor, all.events[1]!.eventId);
    // The subscribe is still idempotent after the restart.
    assert.deepEqual(await restarted.hub.subscribe(scopeOf('mara'), ENGINE), { outcome: 'subscribed' });
    const { rows } = await pool.query('SELECT 1 FROM conversation_message_subscriptions');
    assert.equal(rows.length, 1);
  });

  it('stores a redelivery once and survives concurrent edits', async () => {
    const f = await boot();
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
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

  it('getEvent is blind to foreign conversations and to an earlier subscription', async () => {
    const f = await boot();
    await f.hub.ingest(messageEvent({ messageId: 'early' }));
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    await f.hub.subscribe(scopeOf('nora', '19:other@thread.v2'), ENGINE);
    await f.hub.ingest(messageEvent({ messageId: 'm1' }));
    await f.hub.ingest(
      messageEvent({ messageId: 'x1', conversationId: '19:other@thread.v2', receivedByChannelKey: NORA_KEY }),
    );
    // Two bots in one chat: nora's copy of the same message is not stored.
    assert.equal(await f.hub.ingest(messageEvent({ messageId: 'm1', receivedByChannelKey: NORA_KEY })), undefined);
    assert.equal(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'early'), undefined);
    assert.equal(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'x1'), undefined);
    assert.equal(await f.hub.getEvent(scopeOf('mara'), '@acme/snoop', 'm1'), undefined);
    assert.ok(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1'));

    await f.hub.unsubscribe(scopeOf('mara'), ENGINE);
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    assert.equal(await f.hub.getEvent(scopeOf('mara'), ENGINE, 'm1'), undefined, 'a new subscription starts empty');
    const rows = await pool.query<{ active: boolean }>(
      `SELECT ended_at IS NULL AS active FROM conversation_message_subscriptions
        WHERE agent_slug = 'mara' ORDER BY created_at`,
    );
    assert.deepEqual(rows.rows.map((r) => r.active), [false, true]);
  });

  it('holds one active subscription per identity and conversation, lower-cased', async () => {
    const store = new PgConversationMessageStore(pool);
    const input = {
      agentId: DEFAULT_AGENTS[0]!.id,
      agentSlug: 'mara',
      channelType: 'teams',
      conversationId: CONVERSATION,
      channelKey: MARA_KEY,
      pluginId: ENGINE,
    };
    const first = await store.createSubscription(input);
    const again = await store.createSubscription({ ...input, channelKey: MARA_KEY.toUpperCase() });
    assert.equal(again.id, first.id);
    assert.equal(first.channelKey, MARA_KEY.toLowerCase());
    await assert.rejects(
      pool.query(
        `INSERT INTO conversation_message_subscriptions
           (agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id)
         VALUES ($1, 'mara', 'teams', $2, $3, $4)`,
        [input.agentId, CONVERSATION, MARA_KEY.toLowerCase(), ENGINE],
      ),
      (err: { constraint?: string }) => err.constraint === 'conversation_message_subscriptions_active_uq',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO conversation_message_subscriptions
           (agent_id, agent_slug, channel_type, conversation_id, channel_key, plugin_id)
         VALUES ($1, 'mara', 'teams', 'c2', '28:UPPER', $2)`,
        [input.agentId, ENGINE],
      ),
      (err: { code?: string }) => err.code === '23514',
    );
  });

  it('purges after the grace period and by age, and with the agent', async () => {
    const f = await boot();
    const store = new PgConversationMessageStore(pool);
    await f.hub.subscribe(scopeOf('mara'), ENGINE);
    await f.hub.subscribe(scopeOf('nora'), ENGINE);
    await f.hub.ingest(messageEvent());
    await f.hub.ingest(messageEvent({ messageId: 'm2' }));
    await f.hub.ingest(messageEvent({ receivedByChannelKey: NORA_KEY }));
    const count = async (): Promise<number> =>
      Number((await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM conversation_message_events')).rows[0]!.n);
    assert.equal(await count(), 3);

    // Still subscribed: nothing goes, however long ago the cut-off is set.
    assert.deepEqual(await store.purge({ endedBefore: new Date(Date.now() + 60_000) }), { events: 0, subscriptions: 0 });

    await f.hub.unsubscribe(scopeOf('mara'), ENGINE);
    // Inside the grace period: kept.
    assert.deepEqual(await store.purge({ endedBefore: new Date(Date.now() - 60_000) }), { events: 0, subscriptions: 0 });
    // Grace period over: mara's two events and the ended row go, nora's stays.
    assert.deepEqual(await store.purge({ endedBefore: new Date(Date.now() + 60_000) }), { events: 2, subscriptions: 1 });
    assert.equal(await count(), 1);

    // Maximum age applies to a live subscription too.
    await pool.query(`UPDATE conversation_message_events SET received_at = now() - interval '31 days'`);
    const aged = await store.purge({
      endedBefore: new Date(0),
      receivedBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    assert.deepEqual(aged, { events: 1, subscriptions: 0 });

    // Deleting the agent removes its subscription and whatever it received.
    await f.hub.ingest(messageEvent({ messageId: 'm9', receivedByChannelKey: NORA_KEY }));
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

      assert.deepEqual(await f.hub.subscribe(scopeOf('mara'), ENGINE), { outcome: 'subscribed' });
      assert.deepEqual(await f.hub.subscribe(scopeOf('nora'), ENGINE), { outcome: 'subscribed' });
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
});
