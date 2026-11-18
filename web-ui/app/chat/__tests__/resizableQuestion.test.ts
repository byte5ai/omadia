import { describe, expect, it } from 'vitest';

import type { Message } from '../../_lib/chatSessions';
import { resizableQuestionFor } from '../page';

function msg(over: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return { startedAt: 0, tools: [], ...over };
}

/**
 * "Kürzer" / "Mehr Details" re-ask the question an answer belongs to. The
 * cases below pin which user message counts as that question.
 */
describe('resizableQuestionFor', () => {
  it('finds the typed question right above the answer', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'Wie viele offene Rechnungen?' }),
      msg({ id: 'a1', role: 'assistant', content: '12.' }),
    ];
    expect(resizableQuestionFor(messages, 1)).toBe('Wie viele offene Rechnungen?');
  });

  it('skips routine deliveries and earlier answers on the way up', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'Frage' }),
      msg({ id: 'a1', role: 'assistant', content: 'Antwort' }),
      msg({
        id: 'p1',
        role: 'assistant',
        content: 'Routine: nichts Neues',
        proactive: { deliveredAt: 1 },
      }),
      msg({ id: 'a2', role: 'assistant', content: 'Nachtrag' }),
    ];
    expect(resizableQuestionFor(messages, 3)).toBe('Frage');
  });

  it('yields nothing for the answer to a choice-card click — the "question" is an option label', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'Welcher Kunde?' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: 'Meinst du A oder B?',
        pendingUserChoice: { question: 'Meinst du A oder B?', options: [] } as never,
      }),
      msg({ id: 'u2', role: 'user', content: 'A' }),
      msg({ id: 'a2', role: 'assistant', content: 'Kunde A hat 3 offene Posten.' }),
    ];
    expect(resizableQuestionFor(messages, 3)).toBeUndefined();
  });

  it('yields nothing for the answer to a follow-up click', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'Umsatz Q3?' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '1,2 Mio.',
        followUpOptions: [{ label: 'Und Q4?', prompt: 'Umsatz Q4?' }],
      }),
      msg({ id: 'u2', role: 'user', content: 'Umsatz Q4?' }),
      msg({ id: 'a2', role: 'assistant', content: '1,4 Mio.' }),
    ];
    expect(resizableQuestionFor(messages, 3)).toBeUndefined();
  });

  it('yields nothing for an empty (file-only) user message', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '   ' }),
      msg({ id: 'a1', role: 'assistant', content: 'Datei gelesen.' }),
    ];
    expect(resizableQuestionFor(messages, 1)).toBeUndefined();
  });
});
