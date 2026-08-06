import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatSessions, type ChatSession, type Message } from '../chatSessions';

/**
 * #617 — the old active-session persist helper resolved its snapshot through
 * an active-id ref and an effect-synced sessions ref, so a background turn PUT
 * whichever session the user happened to be looking at, from state that could
 * still predate the `done` fold. A background turn gets no corrective follow-up
 * turn, so that stale snapshot was the FINAL persisted state and the answer did
 * not survive a reload.
 *
 * These tests pin the replacement contract: `persistById` writes the session
 * it was handed, from state that has already committed, and it silently drops
 * the write when that session is gone.
 */

const ID_A = 'session-a';
const ID_B = 'session-b';

interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
}

let calls: RecordedCall[] = [];

function assistantMessage(content: string): Message {
  return {
    id: `msg-${content}`,
    role: 'assistant',
    content,
    startedAt: 1_000,
  };
}

function remoteSession(id: string, updatedAt: number): ChatSession {
  return {
    id,
    title: id,
    createdAt: 1_000,
    updatedAt,
    messages: [assistantMessage('hello')],
  };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Backend fake: two sessions, `ID_A` newer so hydration makes it the active
 * one and `ID_B` is the background session under test.
 */
function installFetchMock(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      if (method === 'GET' && url === '/bot-api/chat/sessions') {
        return Promise.resolve(
          json({
            sessions: [
              { id: ID_A, title: ID_A, createdAt: 1_000, updatedAt: 2_000, messageCount: 1 },
              { id: ID_B, title: ID_B, createdAt: 1_000, updatedAt: 1_500, messageCount: 1 },
            ],
          }),
        );
      }
      if (method === 'GET' && url.endsWith(ID_A)) {
        return Promise.resolve(json(remoteSession(ID_A, 2_000)));
      }
      if (method === 'GET' && url.endsWith(ID_B)) {
        return Promise.resolve(json(remoteSession(ID_B, 1_500)));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    },
  );
}

function putsFor(id: string): RecordedCall[] {
  return calls.filter((c) => c.method === 'PUT' && c.url.endsWith(id));
}

async function hydrated(): Promise<
  ReturnType<typeof renderHook<ReturnType<typeof useChatSessions>, unknown>>
> {
  const view = renderHook(() => useChatSessions());
  await waitFor(() => {
    expect(view.result.current.hydrating).toBe(false);
  });
  expect(view.result.current.activeId).toBe(ID_A);
  return view;
}

beforeEach(() => {
  calls = [];
  window.localStorage.clear();
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useChatSessions — persistById (#617)', () => {
  it('PUTs the named background session from post-commit state', async () => {
    const view = await hydrated();
    calls = [];

    act(() => {
      view.result.current.mutateById(ID_B, (s) => ({
        ...s,
        messages: [...s.messages, assistantMessage('final answer')],
        updatedAt: 3_000,
      }));
      view.result.current.persistById(ID_B);
    });

    const puts = putsFor(ID_B);
    expect(puts).toHaveLength(1);

    const payload = JSON.parse(puts[0]?.body ?? '{}') as ChatSession;
    expect(payload.messages.at(-1)?.content).toBe('final answer');
    // The active session is a bystander — it must not be written.
    expect(putsFor(ID_A)).toHaveLength(0);
  });

  it('drops the PUT when the session was deleted before the turn finished', async () => {
    const view = await hydrated();

    await act(async () => {
      await view.result.current.deleteSession(ID_B);
    });
    calls = [];

    act(() => {
      view.result.current.persistById(ID_B);
    });

    expect(putsFor(ID_B)).toHaveLength(0);
  });
});
