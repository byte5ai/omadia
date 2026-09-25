import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatSessions, type ChatSession, type Message } from '../chatSessions';

/**
 * #1071 — a routine delivery bumps the server clock, so a server copy can be
 * NEWER while still holding a title this browser already changed (the rename's
 * PUT failed). `titleUnsynced` remembers that the rename never reached the
 * server, so hydration keeps it instead of silently reverting it.
 */

const ID = 'session-t';
const LS_SESSIONS = 'odoo-bot-chat-sessions';

const USER_TURN: Message = { id: 'u1', role: 'user', content: 'hi', startedAt: 1_000 };
const DELIVERY: Message = {
  id: 'proactive-r1-9000',
  role: 'assistant',
  content: 'Report',
  startedAt: 9_000,
  finishedAt: 9_000,
  proactive: { deliveredAt: 9_000, routineId: 'r1' },
};

let server: ChatSession;
let putStatus = 200;
let putBodies: Record<string, unknown>[] = [];
let requests: string[] = [];
// When set, a PUT waits for this answer instead of answering at once.
let putAnswer: Promise<Response> | null = null;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  putStatus = 200;
  putBodies = [];
  requests = [];
  putAnswer = null;
  window.localStorage.clear();
  server = { id: ID, title: 'Old', createdAt: 1_000, updatedAt: 2_000, messages: [USER_TURN] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      if (method === 'PUT') {
        putBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (putStatus !== 200) return Promise.resolve(new Response('', { status: putStatus }));
        if (putAnswer) return putAnswer;
        return Promise.resolve(json({ ok: true }));
      }
      if (url === '/bot-api/chat/sessions') {
        const { messages, ...rest } = server;
        return Promise.resolve(json({ sessions: [{ ...rest, messageCount: messages.length }] }));
      }
      return Promise.resolve(json(server));
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

function storedChat(): Record<string, unknown> | undefined {
  const raw = window.localStorage.getItem(LS_SESSIONS);
  const all = raw ? (JSON.parse(raw) as Record<string, unknown>[]) : [];
  return all.find((s) => s['id'] === ID);
}

function chat(view: { result: { current: ReturnType<typeof useChatSessions> } }): ChatSession | undefined {
  return view.result.current.sessions.find((s) => s.id === ID);
}

describe('useChatSessions — rename sync (#1071)', () => {
  it('marks a rename whose PUT failed as unsynced and never sends the marker', async () => {
    const view = await hydrated();
    putStatus = 503;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await act(async () => {
      await view.result.current.renameSession(ID, 'Quarterly');
    });

    expect(chat(view)?.title).toBe('Quarterly');
    expect(chat(view)?.titleUnsynced).toBe(true);
    expect(putBodies.at(-1)?.['title']).toBe('Quarterly');
    expect(putBodies.at(-1)).not.toHaveProperty('titleUnsynced');
    warn.mockRestore();
  });

  it('settles the rename once its PUT succeeds', async () => {
    const view = await hydrated();

    await act(async () => {
      await view.result.current.renameSession(ID, 'Quarterly');
    });

    expect(chat(view)?.title).toBe('Quarterly');
    expect(chat(view)?.titleUnsynced).toBeUndefined();
  });

  it('stores the settled title when the rename answer also carries a new delivery', async () => {
    const view = await hydrated();
    let answer: (res: Response) => void = () => undefined;
    putAnswer = new Promise<Response>((resolve) => {
      answer = resolve;
    });

    let renamed: Promise<void> = Promise.resolve();
    act(() => {
      renamed = view.result.current.renameSession(ID, 'Quarterly');
    });
    // The slow PUT outlives the debounced write of the still-unsynced rename.
    await waitFor(() => {
      expect(storedChat()?.['titleUnsynced']).toBe(true);
    });

    const merged = { ...server, title: 'Quarterly', updatedAt: 9_000, messages: [USER_TURN, DELIVERY] };
    await act(async () => {
      answer(json({ ok: true, session: merged }));
      await renamed;
    });

    expect(chat(view)?.titleUnsynced).toBeUndefined();
    expect(chat(view)?.messages.map((m) => m.id)).toEqual(['u1', DELIVERY.id]);
    // Settling the title is a local edit, not a fold: the stored copy must
    // lose the marker too, or a later hydration keeps a stale title.
    await waitFor(() => {
      expect(storedChat()).not.toHaveProperty('titleUnsynced');
    });
    expect(storedChat()?.['title']).toBe('Quarterly');
  });

  it('hydration keeps an unsynced rename although a delivery made the server copy newer', async () => {
    window.localStorage.setItem(
      LS_SESSIONS,
      JSON.stringify([
        { id: ID, title: 'Quarterly', createdAt: 1_000, updatedAt: 3_000, messages: [USER_TURN], titleUnsynced: true },
      ]),
    );
    server = { ...server, updatedAt: 9_000, messages: [USER_TURN, DELIVERY] };

    const view = await hydrated();

    expect(chat(view)?.title).toBe('Quarterly');
    expect(chat(view)?.messages.map((m) => m.id)).toEqual(['u1', DELIVERY.id]);
    await waitFor(() => {
      expect(putBodies.some((b) => b['title'] === 'Quarterly')).toBe(true);
    });
    // The catch-up PUT landed: the rename is on the server now.
    await waitFor(() => {
      expect(chat(view)?.titleUnsynced).toBeUndefined();
    });
  });

  it('a clear of a chat this tab does not hold sends nothing and reports no partial clear', async () => {
    const view = await hydrated();
    requests = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let outcome: unknown;
    await act(async () => {
      outcome = await view.result.current.clearMessages('not-loaded');
    });

    expect(outcome).toBe('not_loaded');
    expect(requests).toEqual([]);
    warn.mockRestore();
  });
});
