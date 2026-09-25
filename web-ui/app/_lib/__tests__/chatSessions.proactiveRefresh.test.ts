import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatSessions, type ChatSession, type Message } from '../chatSessions';

/**
 * #1071 — the web chat has no live push, so a routine delivery the server
 * appended after page load reaches the UI through a re-read when the user
 * switches to that chat. The re-read is additive and never writes back.
 */

const ID_A = 'session-a';
const ID_B = 'session-b';

const DELIVERY: Message = {
  id: 'proactive-r1-9000',
  role: 'assistant',
  content: 'Report',
  startedAt: 9_000,
  finishedAt: 9_000,
  proactive: { deliveredAt: 9_000, routineId: 'r1', routineName: 'Daily' },
};

let serverB: ChatSession;
let puts: string[] = [];

function session(id: string, updatedAt: number, messages: Message[]): ChatSession {
  return { id, title: id, createdAt: 1_000, updatedAt, messages };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  puts = [];
  window.localStorage.clear();
  serverB = session(ID_B, 1_500, [{ id: 'u1', role: 'user', content: 'hi', startedAt: 1_000 }]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'PUT') puts.push(url);
      if (method === 'GET' && url === '/bot-api/chat/sessions') {
        return Promise.resolve(
          json({
            sessions: [
              { id: ID_A, title: ID_A, createdAt: 1_000, updatedAt: 2_000, messageCount: 0 },
              { id: ID_B, title: ID_B, createdAt: 1_000, updatedAt: 1_500, messageCount: 1 },
            ],
          }),
        );
      }
      if (method === 'GET' && url.endsWith(ID_A)) return Promise.resolve(json(session(ID_A, 2_000, [])));
      if (method === 'GET' && url.endsWith(ID_B)) return Promise.resolve(json(serverB));
      return Promise.resolve(new Response('', { status: 200 }));
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useChatSessions — proactive re-read (#1071)', () => {
  it('switching to a chat folds in a delivery the server appended since hydration', async () => {
    const view = renderHook(() => useChatSessions());
    await waitFor(() => {
      expect(view.result.current.hydrating).toBe(false);
    });
    puts = [];

    // The routine fires while the user looks at another chat.
    serverB = { ...serverB, updatedAt: 9_000, messages: [...serverB.messages, DELIVERY] };

    act(() => {
      view.result.current.setActive(ID_B);
    });

    await waitFor(() => {
      expect(view.result.current.activeSession.messages.map((m) => m.id)).toEqual(['u1', DELIVERY.id]);
    });
    expect(view.result.current.activeSession.messages.at(-1)?.proactive?.routineName).toBe('Daily');
    expect(puts).toEqual([]);
  });
});
