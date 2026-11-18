import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatSessions, type ChatSession, type Message } from '../chatSessions';

/**
 * #1071 — every omadia tab mounts the chat-sessions provider, so a tab loaded
 * long ago folds a routine delivery the moment it regains focus. That fold
 * must persist ONLY the delivery, into the one stored chat it belongs to: a
 * stale tab writing its whole in-memory array would roll back what other tabs
 * stored since and bring chats they deleted back (hydration would then
 * re-create them on the server).
 */

const LS_SESSIONS = 'odoo-bot-chat-sessions';
const LS_ACTIVE = 'odoo-bot-chat-active-id';
const ID_A = 'session-a';
const ID_B = 'session-b';
const ID_Y = 'session-y';

const DELIVERY: Message = {
  id: 'proactive-r1-9000',
  role: 'assistant',
  content: 'Report',
  startedAt: 9_000,
  finishedAt: 9_000,
  proactive: { deliveredAt: 9_000, routineId: 'r1', routineName: 'Daily' },
};

const USER_TURN: Message = { id: 'u1', role: 'user', content: 'hi', startedAt: 1_000 };

/** A turn another tab adds, with a field the server's PUT schema strips. */
const RICH_ANSWER = {
  id: 'a2',
  role: 'assistant',
  content: 'Here is the chart',
  startedAt: 3_100,
  finishedAt: 3_200,
  attachments: [{ kind: 'image', url: '/diagrams/x.png', altText: 'chart' }],
} as unknown as Message;

let server: Map<string, ChatSession>;
let requests: string[] = [];

function session(id: string, updatedAt: number, messages: Message[]): ChatSession {
  return { id, title: id, createdAt: 1_000, updatedAt, messages };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stored(): ChatSession[] {
  return JSON.parse(window.localStorage.getItem(LS_SESSIONS) ?? '[]') as ChatSession[];
}

function storedById(id: string): ChatSession | undefined {
  return stored().find((s) => s.id === id);
}

async function hydrated(): Promise<ReturnType<typeof renderHook<ReturnType<typeof useChatSessions>, unknown>>> {
  const view = renderHook(() => useChatSessions());
  await waitFor(() => {
    expect(view.result.current.hydrating).toBe(false);
  });
  // Let the post-hydration debounced write settle.
  await settle();
  return view;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

beforeEach(() => {
  requests = [];
  window.localStorage.clear();
  const initial = [
    session(ID_A, 2_000, [USER_TURN]),
    session(ID_B, 1_900, [USER_TURN]),
    session(ID_Y, 1_800, []),
  ];
  server = new Map(initial.map((s) => [s.id, s]));
  window.localStorage.setItem(LS_SESSIONS, JSON.stringify(initial));
  window.localStorage.setItem(LS_ACTIVE, ID_A);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      if (method === 'GET' && url === '/bot-api/chat/sessions') {
        const sessions = [...server.values()].map((s) => ({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
        }));
        return Promise.resolve(json({ sessions }));
      }
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      if (method === 'DELETE') {
        server.delete(id);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as ChatSession;
        server.set(body.id, body);
        return Promise.resolve(json({ ok: true }));
      }
      const found = server.get(id);
      return Promise.resolve(found ? json(found) : new Response('', { status: 404 }));
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useChatSessions — a stale tab folding a delivery (#1071)', () => {
  it('stores only the delivery and keeps what another tab stored since', async () => {
    const stale = await hydrated();
    const fresh = await hydrated();

    // The other tab works on: a new turn in chat B, and chat Y is deleted.
    act(() => {
      fresh.result.current.setActive(ID_B);
      fresh.result.current.mutateById(ID_B, (s) => ({
        ...s,
        updatedAt: 3_200,
        messages: [...s.messages, RICH_ANSWER],
      }));
    });
    await act(async () => {
      await fresh.result.current.deleteSession(ID_Y);
    });
    await settle();
    expect(stored().map((s) => s.id)).toEqual([ID_A, ID_B]);

    // A routine delivers into the stale tab's open chat; that tab regains focus.
    const serverA = server.get(ID_A);
    if (!serverA) throw new Error('chat A missing on the server');
    server.set(ID_A, { ...serverA, updatedAt: 9_000, messages: [...serverA.messages, DELIVERY] });
    requests = [];
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(
        stale.result.current.sessions.find((s) => s.id === ID_A)?.messages.map((m) => m.id),
      ).toEqual(['u1', DELIVERY.id]);
    });
    await settle();

    // The deleted chat stays deleted, the other tab's turn keeps its
    // client-only fields, and the delivery is stored in its chat.
    expect(stored().map((s) => s.id)).toEqual([ID_A, ID_B]);
    expect(storedById(ID_B)?.messages.map((m) => m.id)).toEqual(['u1', 'a2']);
    expect(storedById(ID_B)?.messages[1]?.attachments).toEqual(RICH_ANSWER.attachments);
    expect(storedById(ID_A)?.messages.map((m) => m.id)).toEqual(['u1', DELIVERY.id]);
    expect(requests.filter((r) => !r.startsWith('GET'))).toEqual([]);

    // The next page load does not re-create the deleted chat on the server.
    stale.unmount();
    fresh.unmount();
    requests = [];
    const reloaded = await hydrated();
    expect(reloaded.result.current.sessions.map((s) => s.id).sort()).toEqual([ID_A, ID_B]);
    expect(requests.some((r) => r.includes(ID_Y))).toBe(false);
    expect(server.has(ID_Y)).toBe(false);
  });

  it('still writes a pending local edit whole when a fold lands before the debounce', async () => {
    const view = await hydrated();
    const serverA = server.get(ID_A);
    if (!serverA) throw new Error('chat A missing on the server');
    server.set(ID_A, { ...serverA, updatedAt: 9_000, messages: [...serverA.messages, DELIVERY] });

    act(() => {
      view.result.current.renameSession(ID_B, 'Renamed').catch(() => undefined);
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(
        view.result.current.sessions.find((s) => s.id === ID_A)?.messages.map((m) => m.id),
      ).toEqual(['u1', DELIVERY.id]);
    });
    await settle();

    expect(storedById(ID_B)?.title).toBe('Renamed');
    expect(storedById(ID_A)?.messages.map((m) => m.id)).toEqual(['u1', DELIVERY.id]);
  });

  it('does not store a delivery into a chat another tab cleared after the server copy was read', async () => {
    const view = await hydrated();
    const serverA = server.get(ID_A);
    if (!serverA) throw new Error('chat A missing on the server');
    // The server copy this tab reads still holds the delivery (read before
    // the clear); meanwhile another tab cleared the chat and stored it.
    server.set(ID_A, { ...serverA, updatedAt: 9_000, messages: [...serverA.messages, DELIVERY] });
    window.localStorage.setItem(
      LS_SESSIONS,
      JSON.stringify(stored().map((s) => (s.id === ID_A ? { ...s, messages: [], resetAt: 9_500 } : s))),
    );

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(
        view.result.current.sessions.find((s) => s.id === ID_A)?.messages.map((m) => m.id),
      ).toEqual(['u1', DELIVERY.id]);
    });
    await settle();

    expect(storedById(ID_A)?.messages).toEqual([]);
    expect(storedById(ID_A)?.resetAt).toBe(9_500);
  });
});
