import { describe, expect, it, vi } from 'vitest';

import { applyStreamEvent, type ChatStreamEvent } from '../chatStreamEvents';
import type { ChatSession, Message, UseChatSessionsResult } from '../chatSessions';

/**
 * #2045 — every message in the web chat carries its speaker (spec 2042
 * INV-4): the `agent_bound` header names the agent before the first token,
 * `done` is authoritative, and a management-layer notice arrives with speaker
 * `system` and its `systemNotice`.
 */

const mira = { kind: 'agent', agentId: 'id-mira', slug: 'mira', displayName: 'Mira' } as const;

function fold(events: ChatStreamEvent[]): Message {
  let session: ChatSession = {
    id: 's1',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: 'p', role: 'assistant', content: '', startedAt: 1, streaming: true }],
  };
  const mutateById = vi.fn((_id: string, mutate: (s: ChatSession) => ChatSession) => {
    session = mutate(session);
  });
  const sessions = { mutateById } as unknown as UseChatSessionsResult;
  for (const event of events) applyStreamEvent(sessions, 's1', 'p', event);
  return session.messages[0]!;
}

describe('speaker per message', () => {
  it('agent_bound names the agent before the answer, done keeps it', () => {
    expect(fold([{ type: 'agent_bound', slug: 'mira', speaker: mira }]).speaker).toEqual(mira);
    const done = fold([
      { type: 'agent_bound', slug: 'mira', speaker: mira },
      { type: 'text_delta', text: 'Hallo' },
      { type: 'done', answer: 'Hallo', toolCalls: 0, iterations: 1, speaker: mira },
    ]);
    expect(done.speaker).toEqual(mira);
    expect(done.content).toBe('Hallo');
  });

  it('a system notice turns the message into a system message', () => {
    const notice = fold([
      {
        type: 'done',
        answer: 'Mira ist derzeit deaktiviert.',
        toolCalls: 0,
        iterations: 0,
        speaker: { kind: 'system' },
        systemNotice: { code: 'agent_disabled', text: 'Mira ist derzeit deaktiviert.' },
      },
    ]);
    expect(notice.speaker).toEqual({ kind: 'system' });
    expect(notice.systemNotice?.code).toBe('agent_disabled');
  });

  it('an error keeps the name of the agent whose turn failed', () => {
    expect(fold([{ type: 'error', message: 'boom', speaker: mira }]).speaker).toEqual(mira);
  });
});
