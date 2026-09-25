import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatSessions, type ChatSession, type Message } from '../chatSessions';

/**
 * #1071 — the web chat has no live push, so a routine delivery the server
 * appended after page load reaches the UI through (a) hydration, (b) an
 * explicit re-read (`refreshProactive`, called by the chat page) and (c) the
 * document the server answers a PUT with. All three are additive: a delivery
 * must never cost the local copy the fields only the browser keeps.
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

const USER_TURN: Message = { id: 'u1', role: 'user', content: 'hi', startedAt: 1_000 };

/** A local answer with fields the server's PUT schema strips. */
const RICH_ANSWER = {
  id: 'a1',
  role: 'assistant',
  content: 'Here is the chart',
  startedAt: 1_100,
  finishedAt: 1_200,
  attachments: [{ kind: 'image', url: '/diagrams/x.png', altText: 'chart' }],
  privacyReceipt: { receiptId: 'rcpt-1' },
} as unknown as Message;

let serverA: ChatSession;
let serverB: ChatSession;
let putResponse: ChatSession | null = null;
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

function summary(s: ChatSession): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
  };
}

beforeEach(() => {
  puts = [];
  putResponse = null;
  window.localStorage.clear();
  serverA = session(ID_A, 2_000, []);
  serverB = session(ID_B, 1_500, [USER_TURN]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'PUT') {
        puts.push(url);
        return Promise.resolve(putResponse ? json({ ok: true, session: putResponse }) : json({ ok: true }));
      }
      if (method === 'GET' && url === '/bot-api/chat/sessions') {
        return Promise.resolve(json({ sessions: [summary(serverA), summary(serverB)] }));
      }
      if (method === 'GET' && url.endsWith(ID_A)) return Promise.resolve(json(serverA));
      if (method === 'GET' && url.endsWith(ID_B)) return Promise.resolve(json(serverB));
      return Promise.resolve(new Response('', { status: 200 }));
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function hydrated(): Promise<ReturnType<typeof renderHook<ReturnType<typeof useChatSessions>, unknown>>> {
  const view = renderHook(() => useChatSessions());
  await waitFor(() => {
    expect(view.result.current.hydrating).toBe(false);
  });
  return view;
}

function messagesOf(view: { result: { current: ReturnType<typeof useChatSessions> } }, id: string): Message[] {
  return view.result.current.sessions.find((s) => s.id === id)?.messages ?? [];
}

describe('useChatSessions — proactive re-read (#1071)', () => {
  it('refreshProactive folds in a delivery the server appended since hydration', async () => {
    const view = await hydrated();
    puts = [];

    // The routine fires while the user looks at another chat.
    serverB = { ...serverB, updatedAt: 9_000, messages: [...serverB.messages, DELIVERY] };

    act(() => {
      view.result.current.refreshProactive(ID_B);
    });

    await waitFor(() => {
      expect(messagesOf(view, ID_B).map((m) => m.id)).toEqual(['u1', DELIVERY.id]);
    });
    expect(messagesOf(view, ID_B).at(-1)?.proactive?.routineName).toBe('Daily');
    expect(puts).toEqual([]);
  });

  it('hydration keeps client-only fields when the server copy is newer only by a delivery', async () => {
    const local = session(ID_B, 1_500, [USER_TURN, RICH_ANSWER]);
    window.localStorage.setItem('odoo-bot-chat-sessions', JSON.stringify([local]));
    window.localStorage.setItem('odoo-bot-chat-active-id', ID_B);
    // Server copy: the same turn, stripped by the PUT schema, plus a delivery.
    const stripped = { id: 'a1', role: 'assistant', content: 'Here is the chart', startedAt: 1_100, finishedAt: 1_200 } as Message;
    serverB = session(ID_B, 9_000, [USER_TURN, stripped, DELIVERY]);

    const view = await hydrated();

    const messages = messagesOf(view, ID_B);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', DELIVERY.id]);
    const answer = messages[1] as unknown as Record<string, unknown>;
    expect(answer['attachments']).toEqual(RICH_ANSWER.attachments);
    expect(answer['privacyReceipt']).toEqual({ receiptId: 'rcpt-1' });
    expect(messages[2]?.proactive?.routineId).toBe('r1');
  });

  it('hydration keeps a local turn whose PUT failed when a delivery made the server copy newer', async () => {
    // Turn 2's fire-and-forget PUT never reached the server; the routine then
    // fired, so the server copy is newer but BEHIND on turns.
    const u2: Message = { id: 'u2', role: 'user', content: 'and next week?', startedAt: 2_000 };
    const a2: Message = { id: 'a2', role: 'assistant', content: 'Next week…', startedAt: 2_100, finishedAt: 2_200 };
    const local = session(ID_B, 2_200, [USER_TURN, RICH_ANSWER, u2, a2]);
    window.localStorage.setItem('odoo-bot-chat-sessions', JSON.stringify([local]));
    window.localStorage.setItem('odoo-bot-chat-active-id', ID_B);
    const stripped = { id: 'a1', role: 'assistant', content: 'Here is the chart', startedAt: 1_100, finishedAt: 1_200 } as Message;
    serverB = session(ID_B, 9_000, [USER_TURN, stripped, DELIVERY]);

    const view = await hydrated();

    const messages = messagesOf(view, ID_B);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', DELIVERY.id]);
    expect((messages[1] as unknown as Record<string, unknown>)['privacyReceipt']).toEqual({ receiptId: 'rcpt-1' });
    // The backend is healed with the local turns (its merge keeps the delivery).
    await waitFor(() => {
      expect(puts.some((url) => url.endsWith(`/${ID_B}`))).toBe(true);
    });
  });

  it('hydration still takes the server copy when it carries a turn this browser lacks', async () => {
    const local = session(ID_B, 1_500, [USER_TURN]);
    window.localStorage.setItem('odoo-bot-chat-sessions', JSON.stringify([local]));
    const otherDevice: Message = { id: 'u2', role: 'user', content: 'from my phone', startedAt: 5_000 };
    serverB = session(ID_B, 9_000, [USER_TURN, otherDevice]);

    const view = await hydrated();

    expect(messagesOf(view, ID_B).map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('folds a delivery the server merged into its PUT answer', async () => {
    const view = await hydrated();
    putResponse = { ...serverB, updatedAt: 9_000, messages: [USER_TURN, DELIVERY] };

    act(() => {
      view.result.current.persistById(ID_B);
    });

    await waitFor(() => {
      expect(messagesOf(view, ID_B).map((m) => m.id)).toEqual(['u1', DELIVERY.id]);
    });
  });
});
