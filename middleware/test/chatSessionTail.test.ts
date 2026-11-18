/**
 * Issue #1087 — the raw conversation tail the subscription-CLI agent replays.
 *
 * The pairing rules here are the whole point: a persisted chat is a flat list
 * of messages, and the CLI prompt needs COMPLETED (user, assistant) pairs. The
 * web UI PUTs the session around every turn, so the list routinely ends with a
 * user message whose answer has not been written yet — replaying that would
 * hand the model the current question twice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chatSessionTailTurns } from '../packages/harness-orchestrator/src/chatSessionStore.js';
import type { ChatMessage } from '../packages/harness-orchestrator/src/chatSessionStore.js';

function msg(
  role: 'user' | 'assistant',
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id: `${role}-${content}`, role, content, startedAt: 0, ...extra };
}

test('pairs each user message with the answer that follows it, oldest first', () => {
  const turns = chatSessionTailTurns(
    [
      msg('user', 'Wer bist du?'),
      msg('assistant', 'Ich bin dein Assistent.'),
      msg('user', 'Hund oder Katze?'),
      msg('assistant', 'Katze.'),
    ],
    3,
  );

  assert.deepEqual(turns, [
    { userMessage: 'Wer bist du?', assistantAnswer: 'Ich bin dein Assistent.' },
    { userMessage: 'Hund oder Katze?', assistantAnswer: 'Katze.' },
  ]);
});

test('keeps only the newest `limit` turns', () => {
  const messages: ChatMessage[] = [];
  for (let i = 1; i <= 5; i += 1) {
    messages.push(msg('user', `u${String(i)}`), msg('assistant', `a${String(i)}`));
  }

  const turns = chatSessionTailTurns(messages, 2);

  assert.deepEqual(turns, [
    { userMessage: 'u4', assistantAnswer: 'a4' },
    { userMessage: 'u5', assistantAnswer: 'a5' },
  ]);
});

test('drops the trailing unanswered user message (the turn in flight)', () => {
  const turns = chatSessionTailTurns(
    [
      msg('user', 'erste Frage'),
      msg('assistant', 'erste Antwort'),
      // An unanswered trailing question — dropped defensively, in case it is
      // the live turn.
      msg('user', 'Fasse unser Gespräch zusammen'),
    ],
    3,
  );

  assert.deepEqual(turns, [
    { userMessage: 'erste Frage', assistantAnswer: 'erste Antwort' },
  ]);
});

test('drops failed, blank and orphaned messages instead of replaying them', () => {
  const turns = chatSessionTailTurns(
    [
      // Orphan: an answer with no question before it.
      msg('assistant', 'orphan answer'),
      msg('user', 'failed question'),
      msg('assistant', 'Fehler: upstream 500', { error: true }),
      msg('user', 'blank question'),
      msg('assistant', '   '),
      msg('user', 'good question'),
      msg('assistant', 'good answer'),
    ],
    5,
  );

  assert.deepEqual(turns, [
    { userMessage: 'good question', assistantAnswer: 'good answer' },
  ]);
});

test('returns nothing for an empty session or a zero window', () => {
  assert.deepEqual(chatSessionTailTurns([], 3), []);
  assert.deepEqual(
    chatSessionTailTurns([msg('user', 'u'), msg('assistant', 'a')], 0),
    [],
  );
});

// #1071 — a routine's proactive delivery is not an answer to anything the user
// asked. Pairing it would replay a routine report to the model as the answer
// to whatever question happened to be unanswered when it landed.
const PROACTIVE = { proactive: { deliveredAt: 1, routineId: 'r1' } };

test('never pairs a proactive routine delivery with an unanswered user message', () => {
  const turns = chatSessionTailTurns(
    [msg('user', 'offene Frage'), msg('assistant', 'Routine-Report', PROACTIVE)],
    3,
  );

  assert.deepEqual(turns, []);
});

test('skips a proactive delivery between a question and its real answer', () => {
  const turns = chatSessionTailTurns(
    [
      msg('user', 'Frage'),
      msg('assistant', 'Routine-Report', PROACTIVE),
      msg('assistant', 'echte Antwort'),
    ],
    3,
  );

  assert.deepEqual(turns, [{ userMessage: 'Frage', assistantAnswer: 'echte Antwort' }]);
});
