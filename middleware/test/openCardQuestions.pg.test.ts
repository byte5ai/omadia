/**
 * #2086 — the open questions of cards posted as plain text (pg, migration
 * 0101): a question survives a restart, closes with its card, is replaced by a
 * second registration of the same message, and the migration is idempotent
 * (the CI schema job applies everything twice).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { QuestionCard } from '@omadia/plugin-api';
import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { PgOpenCardQuestionStore } from '../src/channels/openCardQuestions.js';

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'openCardQuestions',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL', 'DATABASE_URL'],
  timeoutMs: 1_500,
});

const MIGRATION = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0101_open_card_questions.sql');
const SCHEMA = `open_cards_${String(process.pid)}`;

const card: QuestionCard = {
  cardId: 'c-1',
  title: 'T',
  questions: [{ id: 'q', kind: 'single_choice', label: 'L', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
};
const inAnHour = (): Date => new Date(Date.now() + 3_600_000);

describe('open card questions (pg, migration 0101)', { skip: !pgAvailable }, () => {
  let pool: Pool;
  let store: PgOpenCardQuestionStore;

  before(async () => {
    const bootstrap = new Pool({ connectionString: PG_URL, max: 1 });
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: PG_URL, max: 2, options: `-c search_path=${SCHEMA},public` });
    const sql = await readFile(MIGRATION, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    store = new PgOpenCardQuestionStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it('keeps a question and reads it back, as card or as poll', async () => {
    await store.register({ channelType: 'telegram', conversationId: 'chat-1', messageId: 'm1', agentSlug: 'mara', card, expiresAt: inAnHour() });
    await store.register({ channelType: 'telegram', conversationId: 'chat-1', messageId: 'm2', agentSlug: 'mara', card: { ...card, cardId: 'poll-1' }, asPoll: true, expiresAt: inAnHour() });
    const open = await store.listOpen('telegram', 'chat-1', new Date());
    assert.deepEqual(open.map((q) => q.messageId).sort(), ['m1', 'm2']);
    assert.equal(open.find((q) => q.messageId === 'm1')?.card.cardId, 'c-1');
    assert.equal(open.find((q) => q.messageId === 'm1')?.asPoll, undefined);
    assert.equal(open.find((q) => q.messageId === 'm2')?.asPoll, true);
  });

  it('separates conversations and channels', async () => {
    assert.deepEqual(await store.listOpen('telegram', 'chat-2', new Date()), []);
    assert.deepEqual(await store.listOpen('slack', 'chat-1', new Date()), []);
  });

  it('registering the same message again replaces the question', async () => {
    await store.register({ channelType: 'telegram', conversationId: 'chat-3', messageId: 'm1', agentSlug: 'mara', card, expiresAt: inAnHour() });
    await store.register({ channelType: 'telegram', conversationId: 'chat-3', messageId: 'm1', agentSlug: 'nora', card: { ...card, cardId: 'c-2' }, expiresAt: inAnHour() });
    const open = await store.listOpen('telegram', 'chat-3', new Date());
    assert.equal(open.length, 1);
    assert.equal(open[0]?.card.cardId, 'c-2');
    assert.equal(open[0]?.agentSlug, 'nora');
  });

  it('a closed question is not open, and the next registration prunes it', async () => {
    await store.register({ channelType: 'telegram', conversationId: 'chat-4', messageId: 'old', agentSlug: 'mara', card, expiresAt: new Date(Date.now() - 1000) });
    assert.deepEqual(await store.listOpen('telegram', 'chat-4', new Date()), []);
    await store.register({ channelType: 'telegram', conversationId: 'chat-5', messageId: 'new', agentSlug: 'mara', card, expiresAt: inAnHour() });
    const rows = await pool.query(`SELECT 1 FROM open_card_questions WHERE conversation_id = 'chat-4'`);
    assert.equal(rows.rowCount, 0);
  });
});
