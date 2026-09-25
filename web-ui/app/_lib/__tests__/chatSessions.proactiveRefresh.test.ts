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
let putBodies: ChatSession[] = [];
/** Every request in order, as `METHOD url`. */
let requests: string[] = [];
/** When set, a GET of one session waits for this promise before answering. */
let holdSessionGet: Promise<void> | null = null;
/** When set, POST …/reset waits for this promise before answering. */
let holdReset: Promise<void> | null = null;
/** HTTP status POST …/reset answers with. */
let resetStatus = 200;

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
  putBodies = [];
  requests = [];
  putResponse = null;
  holdSessionGet = null;
  holdReset = null;
  resetStatus = 200;
  window.localStorage.clear();
  serverA = session(ID_A, 2_000, []);
  serverB = session(ID_B, 1_500, [USER_TURN]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push(`${method} ${url}`);
      if (method === 'PUT') {
        puts.push(url);
        putBodies.push(JSON.parse(String(init?.body)) as ChatSession);
        return Promise.resolve(putResponse ? json({ ok: true, session: putResponse }) : json({ ok: true }));
      }
      if (method === 'GET' && url === '/bot-api/chat/sessions') {
        return Promise.resolve(json({ sessions: [summary(serverA), summary(serverB)] }));
      }
      const answer = async (read: () => ChatSession): Promise<Response> => {
        if (holdSessionGet) await holdSessionGet;
        return json(read());
      };
      if (method === 'POST' && url.endsWith('/reset')) {
        const reset = async (): Promise<Response> => {
          if (holdReset) await holdReset;
          if (resetStatus !== 200) return new Response('', { status: resetStatus });
          return json({ sessionId: ID_B, newConversationId: `${ID_B}:7000`, resetAt: 7_000 });
        };
        return reset();
      }
      if (method === 'GET' && url.endsWith(ID_A)) return answer(() => serverA);
      if (method === 'GET' && url.endsWith(ID_B)) return answer(() => serverB);
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
    // The fold keeps the local clock: had this chat's last turn PUT failed,
    // the next hydration must still see the server as newer and reconcile.
    expect(view.result.current.sessions.find((s) => s.id === ID_B)?.updatedAt).toBe(1_500);
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

  // Turn 2 as the browser holds it, and as the in-process runtime's
  // SessionLogger mirrors it into the server copy (`srv-u-<startedAt>` /
  // `srv-a-<finishedAt>`) before the client's own PUT would replace those ids.
  const U2: Message = { id: 'u2', role: 'user', content: 'and next week?', startedAt: 2_000 };
  const A2: Message = { id: 'a2', role: 'assistant', content: 'Next week…', startedAt: 2_100, finishedAt: 2_200 };
  const MIRRORED_U2: Message = { id: 'srv-u-2000', role: 'user', content: 'and next week?', startedAt: 2_000, finishedAt: 2_000 };
  const MIRRORED_A2: Message = { id: 'srv-a-2250', role: 'assistant', content: 'Next week…', startedAt: 2_000, finishedAt: 2_250 };
  const STRIPPED_A1 = { id: 'a1', role: 'assistant', content: 'Here is the chart', startedAt: 1_100, finishedAt: 1_200 } as Message;

  it('hydration keeps a local turn whose PUT failed when a delivery made the server copy newer', async () => {
    // Turn 2's fire-and-forget PUT never reached the server — only the
    // server-side mirror of it did; the routine then fired, so the server copy
    // is newer and holds turn 2 under srv-* ids only.
    const local = session(ID_B, 2_200, [USER_TURN, RICH_ANSWER, U2, A2]);
    window.localStorage.setItem('odoo-bot-chat-sessions', JSON.stringify([local]));
    window.localStorage.setItem('odoo-bot-chat-active-id', ID_B);
    serverB = session(ID_B, 9_000, [USER_TURN, STRIPPED_A1, MIRRORED_U2, MIRRORED_A2, DELIVERY]);

    const view = await hydrated();

    const messages = messagesOf(view, ID_B);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', DELIVERY.id]);
    const answer = messages[1] as unknown as Record<string, unknown>;
    expect(answer['privacyReceipt']).toEqual({ receiptId: 'rcpt-1' });
    expect(answer['attachments']).toEqual(RICH_ANSWER.attachments);
    // The backend is healed with the local turns: the catch-up PUT replaces the
    // mirror's srv-* ids with the client's (its merge keeps the delivery).
    await waitFor(() => {
      expect(putBodies.find((b) => b.id === ID_B)?.messages.map((m) => m.id)).toEqual([
        'u1',
        'a1',
        'u2',
        'a2',
        DELIVERY.id,
      ]);
    });
  });

  it('hydration keeps a local turn whose PUT failed and was never mirrored', async () => {
    // Subscription-CLI runtime: no SessionLogger mirror, so the server copy is
    // simply behind on turns.
    const local = session(ID_B, 2_200, [USER_TURN, RICH_ANSWER, U2, A2]);
    window.localStorage.setItem('odoo-bot-chat-sessions', JSON.stringify([local]));
    window.localStorage.setItem('odoo-bot-chat-active-id', ID_B);
    serverB = session(ID_B, 9_000, [USER_TURN, STRIPPED_A1, DELIVERY]);

    const view = await hydrated();

    expect(messagesOf(view, ID_B).map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', DELIVERY.id]);
    await waitFor(() => {
      expect(puts.some((url) => url.endsWith(`/${ID_B}`))).toBe(true);
    });
    // The pushed copy carries the server's clock (never winds it back); the
    // local one keeps its own, so a failed push is retried on the next load.
    expect(putBodies.find((b) => b.id === ID_B)?.updatedAt).toBe(9_000);
    expect(view.result.current.sessions.find((s) => s.id === ID_B)?.updatedAt).toBe(2_200);
  });

  it('hydration lets the mirror win over a partial local answer (mid-stream reload)', async () => {
    // The tab closed mid-stream: localStorage holds a truncated answer, the
    // server mirror holds the whole one. The recovered answer must win.
    const partial: Message = { ...A2, content: 'Next' };
    const local = session(ID_B, 2_150, [USER_TURN, RICH_ANSWER, U2, partial]);
    window.localStorage.setItem('odoo-bot-chat-sessions', JSON.stringify([local]));
    window.localStorage.setItem('odoo-bot-chat-active-id', ID_B);
    serverB = session(ID_B, 9_000, [USER_TURN, STRIPPED_A1, MIRRORED_U2, MIRRORED_A2, DELIVERY]);

    const view = await hydrated();

    const messages = messagesOf(view, ID_B);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'srv-u-2000', 'srv-a-2250', DELIVERY.id]);
    expect(messages[3]?.content).toBe('Next week…');
    expect(puts.some((url) => url.endsWith(`/${ID_B}`))).toBe(false);
  });

  it('hydration still takes the server copy when it carries a turn this browser lacks', async () => {
    const local = session(ID_B, 1_500, [USER_TURN]);
    window.localStorage.setItem('odoo-bot-chat-sessions', JSON.stringify([local]));
    const otherDevice: Message = { id: 'u2', role: 'user', content: 'from my phone', startedAt: 5_000 };
    serverB = session(ID_B, 9_000, [USER_TURN, otherDevice]);

    const view = await hydrated();

    expect(messagesOf(view, ID_B).map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('hydration takes the server copy when the same-id local answer is truncated', async () => {
    // The tab closed right after turn 2's PUT, before the debounced local
    // write caught up; a delivery then landed. Same ids, but the server holds
    // the full answer — it must win, as before #1071.
    const local = session(ID_B, 2_150, [USER_TURN, RICH_ANSWER, U2, { ...A2, content: 'Next' }]);
    window.localStorage.setItem('odoo-bot-chat-sessions', JSON.stringify([local]));
    window.localStorage.setItem('odoo-bot-chat-active-id', ID_B);
    serverB = session(ID_B, 9_000, [USER_TURN, STRIPPED_A1, U2, A2, DELIVERY]);

    const view = await hydrated();

    const messages = messagesOf(view, ID_B);
    expect(messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', DELIVERY.id]);
    expect(messages[3]?.content).toBe('Next week…');
    expect(puts.some((url) => url.endsWith(`/${ID_B}`))).toBe(false);
  });

  it('a re-read that finds no delivery changes no state and writes nothing', async () => {
    const view = await hydrated();
    // Let the post-hydration debounced write settle, then watch for more.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const before = view.result.current.sessions;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    let served = 0;
    const fetchMock = vi.mocked(globalThis.fetch);
    const inner = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith(ID_B)) served += 1;
      return inner ? inner(input, init) : Promise.resolve(new Response(''));
    });

    act(() => {
      view.result.current.refreshProactive(ID_B);
    });
    await waitFor(() => {
      expect(served).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(view.result.current.sessions).toBe(before);
    expect(setItem.mock.calls.filter(([key]) => key === 'odoo-bot-chat-sessions')).toEqual([]);
    expect(puts).toEqual([]);
  });

  it('does not bring back a delivery the user cleared while the re-read was in flight', async () => {
    const view = await hydrated();
    serverB = { ...serverB, updatedAt: 9_000, messages: [...serverB.messages, DELIVERY] };
    let release: () => void = () => undefined;
    holdSessionGet = new Promise<void>((resolve) => {
      release = resolve;
    });

    act(() => {
      view.result.current.refreshProactive(ID_B);
    });
    await act(async () => {
      await view.result.current.clearMessages(ID_B);
    });
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(messagesOf(view, ID_B)).toEqual([]);

    // A delivery that lands after the clear still reaches the chat.
    const later: Message = { ...DELIVERY, id: 'proactive-r1-12000', startedAt: 12_000 };
    serverB = { ...serverB, updatedAt: 12_000, messages: [later] };
    holdSessionGet = null;
    act(() => {
      view.result.current.refreshProactive(ID_B);
    });
    await waitFor(() => {
      expect(messagesOf(view, ID_B).map((m) => m.id)).toEqual([later.id]);
    });
  });

  // An empty `messages` array used to be the server's "clear chat" signal,
  // so renaming a cleared chat — or any PUT of it after a failed re-read —
  // deleted a delivery the tab had never seen. The clear is explicit now
  // (POST …/reset); a rename PUTs without re-reading and folds the delivery
  // the server's merging answer carries.
  it('clears a chat through the explicit reset endpoint, then PUTs the cleared copy', async () => {
    const view = await hydrated();
    act(() => {
      view.result.current.mutateById(ID_B, (s) => ({ ...s, title: 'Kept title' }));
    });
    requests = [];
    putBodies = [];

    await act(async () => {
      await view.result.current.clearMessages(ID_B);
    });

    expect(requests).toEqual([
      `POST /bot-api/chat/sessions/${ID_B}/reset`,
      `PUT /bot-api/chat/sessions/${ID_B}`,
    ]);
    // Built from committed state: the cleared copy keeps everything but the messages.
    expect(putBodies[0]).toMatchObject({ id: ID_B, title: 'Kept title', messages: [] });
    expect(messagesOf(view, ID_B)).toEqual([]);
  });

  it('renaming a cleared chat PUTs the title without a re-read and shows the delivery the server kept', async () => {
    const view = await hydrated();
    await act(async () => {
      await view.result.current.clearMessages(ID_B);
    });
    // The routine fires after the clear; this tab has not re-read yet. The
    // server's merging PUT keeps the delivery and answers with it.
    putResponse = { ...serverB, title: 'Reports', updatedAt: 12_000, messages: [DELIVERY] };
    putBodies = [];
    requests = [];

    await act(async () => {
      await view.result.current.renameSession(ID_B, 'Reports');
    });

    expect(requests).toEqual([`PUT /bot-api/chat/sessions/${ID_B}`]);
    expect(putBodies[0]).toMatchObject({ title: 'Reports', messages: [] });
    await waitFor(() => {
      expect(messagesOf(view, ID_B).map((m) => m.id)).toEqual([DELIVERY.id]);
    });
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

  // A re-read requested AFTER the clear started carries the post-clear
  // epoch, yet if it is answered before the server reset lands it still holds
  // the cleared delivery. Nothing is folded while a clear is in flight.
  it('does not fold a server copy answered while the reset is still in flight', async () => {
    const view = await hydrated();
    serverB = { ...serverB, updatedAt: 9_000, messages: [...serverB.messages, DELIVERY] };
    let releaseReset: () => void = () => undefined;
    holdReset = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });

    let clearing: Promise<unknown> = Promise.resolve();
    act(() => {
      clearing = view.result.current.clearMessages(ID_B);
    });
    act(() => {
      view.result.current.refreshProactive(ID_B);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(messagesOf(view, ID_B)).toEqual([]);

    await act(async () => {
      releaseReset();
      await clearing;
    });
    expect(messagesOf(view, ID_B)).toEqual([]);
  });

  it('remembers the server resetAt of a clear it performed', async () => {
    const view = await hydrated();

    let outcome: unknown;
    await act(async () => {
      outcome = await view.result.current.clearMessages(ID_B);
    });

    expect(outcome).toBe('cleared');
    expect(view.result.current.sessions.find((s) => s.id === ID_B)?.resetAt).toBe(7_000);
  });

  // A failed reset used to fall back to the PUT of `[]` silently: the turns
  // were cleared on the server, its routine deliveries were not, and they
  // came back on the next re-read without a word.
  it('retries a failed reset once and reports a partial clear when it still fails', async () => {
    const view = await hydrated();
    resetStatus = 503;
    requests = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let outcome: unknown;
    await act(async () => {
      outcome = await view.result.current.clearMessages(ID_B);
    });

    expect(outcome).toBe('partial');
    expect(requests).toEqual([
      `POST /bot-api/chat/sessions/${ID_B}/reset`,
      `POST /bot-api/chat/sessions/${ID_B}/reset`,
      `PUT /bot-api/chat/sessions/${ID_B}`,
    ]);
    expect(messagesOf(view, ID_B)).toEqual([]);
    warn.mockRestore();
  });

  // A desktop / Electron window can regain focus without ever turning
  // hidden, so a delivery into the open chat stayed invisible.
  it('re-reads the active chat when the window regains focus', async () => {
    const view = await hydrated();
    act(() => {
      view.result.current.setActive(ID_B);
    });
    serverB = { ...serverB, updatedAt: 9_000, messages: [...serverB.messages, DELIVERY] };

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(messagesOf(view, ID_B).map((m) => m.id)).toEqual(['u1', DELIVERY.id]);
    });
  });
});
