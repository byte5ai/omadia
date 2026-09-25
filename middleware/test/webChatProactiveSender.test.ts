/**
 * #1071 — the browser chat's proactive sender.
 *
 * The web chat had no `ProactiveSender`, so `manage_routine create` from the
 * browser failed with "no proactive sender registered for channel 'web'".
 * The sender delivers into the web chat's own history store: the routine's
 * output becomes an assistant message of the chat it was created in.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore } from '@omadia/orchestrator';
import type { ChatSession } from '@omadia/orchestrator';
import type { SemanticAnswer } from '@omadia/channel-sdk';

import {
  WEB_ROUTINE_CHANNEL,
  createWebChatProactiveSender,
  webChatConversationRef,
} from '../src/plugins/routines/webChatProactiveSender.js';

const SESSION_ID = 'chat-1';
const DELIVERED_AT = 1_800_000_000_000;

function seededSession(): ChatSession {
  return {
    id: SESSION_ID,
    title: 'Routines',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [
      { id: 'u1', role: 'user', content: 'jeden Morgen ein Report', startedAt: 1_700_000_000_000 },
      { id: 'a1', role: 'assistant', content: 'angelegt', startedAt: 1_700_000_000_500 },
    ],
  };
}

async function seededStore(): Promise<ChatSessionStore> {
  const store = new ChatSessionStore(new InMemoryMemoryStore());
  await store.save(seededSession());
  return store;
}

function answer(text: string): SemanticAnswer {
  return { text } as SemanticAnswer;
}

const REF = webChatConversationRef(SESSION_ID, SESSION_ID);
const ROUTINE = { id: 'r-1', name: 'Daily report', cron: '0 8 * * *' };

describe('#1071 — web chat proactive sender', () => {
  it('registers under the web channel id', () => {
    const sender = createWebChatProactiveSender({ getStore: () => undefined });
    assert.equal(sender.channel, WEB_ROUTINE_CHANNEL);
    assert.equal(WEB_ROUTINE_CHANNEL, 'web');
  });

  it('appends the routine output to the originating chat as a proactive assistant message', async () => {
    const store = await seededStore();
    const sender = createWebChatProactiveSender({ getStore: () => store, now: () => DELIVERED_AT });

    await sender.send({ conversationRef: REF, message: answer('**Report**'), routine: ROUTINE });

    const session = await store.get(SESSION_ID);
    assert.ok(session);
    assert.equal(session.messages.length, 3);
    const delivered = session.messages[2];
    assert.ok(delivered);
    assert.equal(delivered.role, 'assistant');
    assert.equal(delivered.content, '**Report**');
    assert.deepEqual(delivered.proactive, {
      deliveredAt: DELIVERED_AT,
      routineId: 'r-1',
      routineName: 'Daily report',
    });
    assert.equal(delivered.startedAt, DELIVERED_AT);
    assert.equal(delivered.finishedAt, DELIVERED_AT);
    assert.ok(session.updatedAt > seededSession().updatedAt, 'updatedAt is bumped');
  });

  it('writes a generic proactive message when no routine metadata is passed (reminders)', async () => {
    const store = await seededStore();
    const sender = createWebChatProactiveSender({ getStore: () => store, now: () => DELIVERED_AT });

    await sender.send({ conversationRef: REF, message: answer('Erinnerung') });

    const delivered = (await store.get(SESSION_ID))?.messages.at(-1);
    assert.ok(delivered);
    assert.deepEqual(delivered.proactive, { deliveredAt: DELIVERED_AT });
    assert.equal(delivered.id, `proactive-reminder-${String(DELIVERED_AT)}`);
  });

  it('fails — and writes nothing — for an empty answer, so the run is not recorded as ok', async () => {
    const store = await seededStore();
    const sender = createWebChatProactiveSender({ getStore: () => store, log: () => {} });

    await assert.rejects(
      sender.send({ conversationRef: REF, message: answer('   '), routine: ROUTINE }),
      /empty answer; nothing was delivered/,
    );

    assert.equal((await store.get(SESSION_ID))?.messages.length, 2);
  });

  // The orchestrator's default answer for a routine with nothing to report is
  // `NO_REPLY` (orchestrator.ts system prompt). Every other routine channel
  // drops it; delivered here it would post the literal sentinel into the chat.
  for (const [label, text] of [
    ['the strict NO_REPLY answer', 'NO_REPLY'],
    ['a NO_REPLY answer with surrounding whitespace', '  NO_REPLY \n'],
    ['NO_REPLY appended after an explanation', 'Keine offenen Tickets heute.\nNO_REPLY'],
  ] as const) {
    it(`drops ${label} — nothing appended, no throw`, async () => {
      const store = await seededStore();
      const sender = createWebChatProactiveSender({ getStore: () => store, now: () => DELIVERED_AT });

      await sender.send({ conversationRef: REF, message: answer(text), routine: ROUTINE });

      const session = await store.get(SESSION_ID);
      assert.equal(session?.messages.length, 2);
      assert.equal(session?.updatedAt, seededSession().updatedAt, 'the chat is untouched');
    });
  }

  it('still delivers an answer that only mentions NO_REPLY mid-text', async () => {
    const store = await seededStore();
    const sender = createWebChatProactiveSender({ getStore: () => store, now: () => DELIVERED_AT });

    await sender.send({
      conversationRef: REF,
      message: answer('Routine NO_REPLY-tracker ist gelaufen: 3 Treffer.'),
      routine: ROUTINE,
    });

    assert.equal((await store.get(SESSION_ID))?.messages.length, 3);
  });

  it('fails for an attachment-only answer instead of silently dropping it', async () => {
    const store = await seededStore();
    const sender = createWebChatProactiveSender({ getStore: () => store, log: () => {} });
    const message = { text: '', attachments: [{ kind: 'image' }] } as unknown as SemanticAnswer;

    await assert.rejects(
      sender.send({ conversationRef: REF, message, routine: ROUTINE }),
      /only attachments \(1\)/,
    );
    assert.equal((await store.get(SESSION_ID))?.messages.length, 2);
  });

  it('delivers the text and warns when attachments are dropped', async () => {
    const store = await seededStore();
    const logs: string[] = [];
    const sender = createWebChatProactiveSender({
      getStore: () => store,
      log: (m) => logs.push(m),
      now: () => DELIVERED_AT,
    });
    const message = { text: 'Report', attachments: [{ kind: 'image' }, { kind: 'file' }] } as unknown as SemanticAnswer;

    await sender.send({ conversationRef: REF, message, routine: ROUTINE });

    assert.equal((await store.get(SESSION_ID))?.messages.at(-1)?.content, 'Report');
    assert.ok(logs.some((l) => /WARN .*dropped 2 attachment/.test(l)), logs.join('\n'));
  });

  it('delivers the text and warns when an interactive card is dropped', async () => {
    const store = await seededStore();
    const logs: string[] = [];
    const sender = createWebChatProactiveSender({
      getStore: () => store,
      log: (m) => logs.push(m),
      now: () => DELIVERED_AT,
    });
    const message = { text: 'Pick one', interactive: { kind: 'choice' } } as unknown as SemanticAnswer;

    await sender.send({ conversationRef: REF, message, routine: ROUTINE });

    assert.equal((await store.get(SESSION_ID))?.messages.at(-1)?.content, 'Pick one');
    assert.ok(logs.some((l) => /WARN .*dropped interactive 'choice'/.test(l)), logs.join('\n'));
  });

  it('throws when the chat session store is not available', async () => {
    const sender = createWebChatProactiveSender({ getStore: () => undefined });
    await assert.rejects(
      sender.send({ conversationRef: REF, message: answer('x'), routine: ROUTINE }),
      /web chat is not configured/,
    );
  });

  it('throws — and does not recreate the chat — when the chat was deleted', async () => {
    const store = await seededStore();
    await store.delete(SESSION_ID);
    const sender = createWebChatProactiveSender({ getStore: () => store });

    await assert.rejects(
      sender.send({ conversationRef: REF, message: answer('x'), routine: ROUTINE }),
      /no longer exists/,
    );
    assert.equal(await store.get(SESSION_ID), null);
  });

  for (const [label, ref] of [
    ['a ref without sessionId', webChatConversationRef('http-default')],
    ['a foreign channel ref', { conversation: { id: 'teams-conv' } }],
    ['an invalid sessionId', { kind: 'http-chat', sessionScope: 'x', sessionId: '../etc' }],
    ['no ref at all', undefined],
  ] as const) {
    it(`rejects ${label} at validation and at send`, async () => {
      const store = await seededStore();
      const sender = createWebChatProactiveSender({ getStore: () => store });
      assert.ok(sender.validateConversationRef);
      assert.throws(() => sender.validateConversationRef?.(ref), /outside a saved web chat/);
      await assert.rejects(
        sender.send({ conversationRef: ref, message: answer('x'), routine: ROUTINE }),
        /outside a saved web chat/,
      );
      assert.equal((await store.get(SESSION_ID))?.messages.length, 2);
    });
  }
});
