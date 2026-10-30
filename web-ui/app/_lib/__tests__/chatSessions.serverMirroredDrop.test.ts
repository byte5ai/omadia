import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isServerMirroredSession,
  useChatSessions,
  type ChatSession,
  type Message,
} from '../chatSessions';

/**
 * The server once mirrored canvas / routine turns into the chat store, and
 * this browser cached those "chats" at hydration. After the server purged
 * them, hydration must not push a cached copy back as a local-only chat —
 * it was never a chat made in this UI.
 */

const LS_SESSIONS = 'odoo-bot-chat-sessions';
const WEB_ID = '04cd6537-9b80-4403-a213-d97260d7c9a3';
const CANVAS_ID = 'omadia-ui-channel-marcel-7ab3b86e';
const LEGACY_ID = 'id-lx3k2-abc12345';

const CLIENT_USER: Message = { id: 'u1', role: 'user', content: 'hi', startedAt: 1_000 };
const MIRRORED_USER: Message = { id: 'srv-u-2000', role: 'user', content: 'rows?', startedAt: 2_000, finishedAt: 2_000 };
const MIRRORED_ANSWER: Message = { id: 'srv-a-2250', role: 'assistant', content: 'rows.', startedAt: 2_000, finishedAt: 2_250 };

function chat(id: string, messages: Message[], updatedAt = 3_000): ChatSession {
  return { id, title: 'T', createdAt: 1_000, updatedAt, messages };
}

let putIds: string[] = [];

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  putIds = [];
  window.localStorage.clear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'PUT') {
        putIds.push((JSON.parse(String(init?.body)) as { id: string }).id);
        return Promise.resolve(json({ ok: true }));
      }
      // The server has purged the mirrored transcript and holds nothing else.
      if (url === '/bot-api/chat/sessions') return Promise.resolve(json({ sessions: [] }));
      return Promise.resolve(new Response('', { status: 404 }));
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function hydratedWith(local: ChatSession[]): Promise<ChatSession[]> {
  window.localStorage.setItem(LS_SESSIONS, JSON.stringify(local));
  const view = renderHook(() => useChatSessions());
  await waitFor(() => {
    expect(view.result.current.hydrating).toBe(false);
  });
  return view.result.current.sessions;
}

describe('isServerMirroredSession', () => {
  it('matches a non-UUID id whose messages are all server-written', () => {
    expect(isServerMirroredSession(chat(CANVAS_ID, [MIRRORED_USER, MIRRORED_ANSWER]))).toBe(true);
  });

  it('never matches one of our UUID ids', () => {
    expect(isServerMirroredSession(chat(WEB_ID, [MIRRORED_USER, MIRRORED_ANSWER]))).toBe(false);
  });

  it('an empty chat or any client-authored message is ours', () => {
    expect(isServerMirroredSession(chat(LEGACY_ID, []))).toBe(false);
    expect(isServerMirroredSession(chat(LEGACY_ID, [CLIENT_USER, MIRRORED_ANSWER]))).toBe(false);
  });

  it('never matches our `id-…` fallback id either, even when only mirrored messages are left', () => {
    // Plain-HTTP LAN host without crypto.randomUUID + a create-PUT that was
    // lost + a mid-stream reload: the only messages are the mirror's. Still ours.
    expect(isServerMirroredSession(chat(LEGACY_ID, [MIRRORED_USER, MIRRORED_ANSWER]))).toBe(false);
  });
});

describe('hydration — a cached server-mirrored transcript is dropped, not pushed back', () => {
  it('drops the mirrored copy from state, localStorage and the push', async () => {
    const sessions = await hydratedWith([
      chat(CANVAS_ID, [MIRRORED_USER, MIRRORED_ANSWER]),
      chat(WEB_ID, [CLIENT_USER]),
    ]);

    expect(sessions.map((s) => s.id)).toEqual([WEB_ID]);
    expect(putIds).toEqual([WEB_ID]);
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(LS_SESSIONS) ?? '[]') as ChatSession[];
      expect(stored.map((s) => s.id)).toEqual([WEB_ID]);
    });
  });

  it('still pushes local-only chats made here — empty ones and legacy ids with client messages', async () => {
    const sessions = await hydratedWith([
      chat(LEGACY_ID, [], 4_000),
      chat(WEB_ID, [], 3_000),
      chat('id-legacy2', [CLIENT_USER, MIRRORED_ANSWER], 2_000),
    ]);

    expect(sessions.map((s) => s.id)).toEqual([LEGACY_ID, WEB_ID, 'id-legacy2']);
    expect(putIds.sort()).toEqual([LEGACY_ID, WEB_ID, 'id-legacy2'].sort());
  });

  it('keeps a fallback-id chat that holds only mirrored messages, also when the remote list fails', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if ((init?.method ?? 'GET') === 'PUT') {
          putIds.push((JSON.parse(String(init?.body)) as { id: string }).id);
          return Promise.resolve(json({ ok: true }));
        }
        return Promise.resolve(new Response('', { status: 503 }));
      },
    );

    const sessions = await hydratedWith([
      chat(LEGACY_ID, [MIRRORED_USER, MIRRORED_ANSWER], 4_000),
      chat(CANVAS_ID, [MIRRORED_USER, MIRRORED_ANSWER], 3_000),
    ]);

    expect(sessions.map((s) => s.id)).toEqual([LEGACY_ID]);
    expect(putIds).toEqual([LEGACY_ID]);
  });

  it('when only mirrored copies were cached, a fresh chat takes their place', async () => {
    const sessions = await hydratedWith([chat(CANVAS_ID, [MIRRORED_USER, MIRRORED_ANSWER])]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).not.toBe(CANVAS_ID);
    expect(sessions[0]?.messages).toEqual([]);
    expect(putIds).not.toContain(CANVAS_ID);
  });
});
