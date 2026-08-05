import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChatSession,
  Message,
  UseChatSessionsResult,
} from '../../_lib/chatSessions';
import {
  StreamStoreProvider,
  useStreamStore,
  type ClaimedRequest,
} from '../../_lib/streamStore';
import { runOneTurn, type DepsRef } from '../StreamRunner';

/**
 * The primary #403 path (verified end to end): the orchestrator fails while the
 * server is ALREADY streaming a 200 response, so the failure arrives as an
 * in-band NDJSON `error` event rather than a non-200 status or a thrown fetch.
 * `runOneTurn` humanizes that message for the chat bubble, but must ALSO finish
 * the stream record as 'error' carrying the humanized sentence — otherwise the
 * background stream tab marker reports success for a turn that actually failed.
 *
 * These tests assert the terminal STORE outcome (phase + record.error), not the
 * rendered bubble, because the bug was a state-transition bug: the bubble was
 * already clean before the fix.
 */

type StoreValue = ReturnType<typeof useStreamStore>;

/** Render a real <StreamStoreProvider> and expose its live context value. */
function captureStore(): { latest: () => StoreValue } {
  let value: StoreValue | null = null;
  function Capture(): null {
    value = useStreamStore();
    return null;
  }
  render(
    <StreamStoreProvider>
      <Capture />
    </StreamStoreProvider>,
  );
  return {
    latest(): StoreValue {
      if (!value) throw new Error('store value never captured');
      return value;
    },
  };
}

/**
 * Minimal chat-sessions stub. `runOneTurn` only ever touches `mutateById`
 * (via applyStreamEvent + finalizePending) and `persistById`; everything else
 * on the context is irrelevant to the store-outcome decision under test.
 */
function stubSessions(): UseChatSessionsResult {
  return {
    mutateById: vi.fn(),
    persistById: vi.fn().mockResolvedValue(undefined),
  } as unknown as UseChatSessionsResult;
}

const GENERIC_FALLBACK = 'Something went wrong talking to the provider.';

/** Translation stub — only `errorProviderGeneric` matters here. */
const tStub = ((key: string): string =>
  key === 'errorProviderGeneric' ? GENERIC_FALLBACK : key) as unknown as DepsRef['current']['t'];

/** A 200 response whose body is exactly `body`, then EOF. */
function ndjson200(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

/**
 * Start a turn, claim it, and run it against the real store with a stub
 * sessions/translations. Returns the sessionId so the caller can read the
 * terminal record.
 */
async function drive(store: StoreValue, response: Response): Promise<string> {
  const sessionId = 'session-403';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

  let claim: ClaimedRequest | undefined;
  await act(async () => {
    store.startTurn({ sessionId, pendingMessageId: 'pending-1', message: 'hi' });
    claim = store.claimRequest();
  });
  if (!claim) throw new Error('claimRequest returned nothing');

  const depsRef: DepsRef = {
    current: { t: tStub, sessions: stubSessions(), store },
  };
  await act(async () => {
    await runOneTurn(claim as ClaimedRequest, depsRef);
  });
  return sessionId;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runOneTurn — in-band error on a 200 stream (#403)', () => {
  it('finishes the stream record as error with the humanized sentence', async () => {
    const { latest } = captureStore();
    const store = latest();

    // The exact failing input from the reviewer: an Anthropic billing error
    // wrapped in a status prefix + JSON envelope, delivered as a single NDJSON
    // `error` line with NO trailing newline (so it lands in the `tail` parse).
    const rawProviderError =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';
    const body = JSON.stringify({ type: 'error', message: rawProviderError });

    const sessionId = await drive(store, ndjson200(body));

    const record = latest().get(sessionId);
    expect(record?.phase).toBe('error');
    expect(record?.error).toBe(
      'Your credit balance is too low to access the Anthropic API.',
    );
  });

  it('also captures an in-band error delivered on a newline-terminated line', async () => {
    const { latest } = captureStore();
    const store = latest();

    const rawProviderError =
      '429 You exceeded your current quota, please check your plan and billing details.';
    const body = `${JSON.stringify({ type: 'error', message: rawProviderError })}\n`;

    const sessionId = await drive(store, ndjson200(body));

    const record = latest().get(sessionId);
    expect(record?.phase).toBe('error');
    expect(record?.error).toBe(
      'You exceeded your current quota, please check your plan and billing details.',
    );
  });

  it('still finishes as done when the stream carries no error event', async () => {
    const { latest } = captureStore();
    const store = latest();

    const body = `${JSON.stringify({
      type: 'done',
      answer: 'all good',
      toolCalls: 0,
      iterations: 1,
    })}\n`;

    const sessionId = await drive(store, ndjson200(body));

    const record = latest().get(sessionId);
    expect(record?.phase).toBe('done');
    expect(record?.error).toBeUndefined();
  });
});

/**
 * #617 — a background turn (its tab is NOT the active one) must fold every
 * event into the session that OWNS it. The pre-fix route went through
 * `mutateActive`/`persistActive`, which only ever touched the active tab, so
 * switching away mid-stream truncated the answer and discarded the `done`
 * event even though the tab advertised "response ready".
 *
 * The stateful fake below is the point of the test: it distinguishes writes by
 * id (like the real store) instead of stubbing them into a black hole, so the
 * assertions fail if the runner ever routes back through the active-tab
 * helpers.
 */
describe('runOneTurn — background session (non-active tab) (#617)', () => {
  /** A stateful sessions fake that routes writes by id, like the real store. */
  function fakeSessions(
    initial: ChatSession[],
    activeId: string,
  ): {
    ctx: UseChatSessionsResult;
    session: (id: string) => ChatSession | undefined;
    persistActiveSpy: ReturnType<typeof vi.fn>;
    persistByIdSpy: ReturnType<typeof vi.fn>;
  } {
    let sessions = initial;
    const persistActiveSpy = vi.fn().mockResolvedValue(undefined);
    const persistByIdSpy = vi.fn().mockResolvedValue(undefined);
    const mutateById = (
      id: string,
      mut: (s: ChatSession) => ChatSession,
    ): void => {
      sessions = sessions.map((s) => (s.id === id ? mut(s) : s));
    };
    const ctx = {
      mutateById,
      mutateActive: (mut: (s: ChatSession) => ChatSession) =>
        mutateById(activeId, mut),
      persistById: persistByIdSpy,
      persistActive: persistActiveSpy,
    } as unknown as UseChatSessionsResult;
    return {
      ctx,
      session: (id: string) => sessions.find((s) => s.id === id),
      persistActiveSpy,
      persistByIdSpy,
    };
  }

  function streamingAssistant(id: string): Message {
    return { id, role: 'assistant', content: '', streaming: true, startedAt: 0 };
  }

  function sessionWith(id: string, messages: Message[]): ChatSession {
    return { id, title: id, createdAt: 0, updatedAt: 0, messages };
  }

  async function driveInto(
    store: StoreValue,
    ctx: UseChatSessionsResult,
    sessionId: string,
    pendingMessageId: string,
    response: Response,
  ): Promise<void> {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    let claim: ClaimedRequest | undefined;
    await act(async () => {
      store.startTurn({ sessionId, pendingMessageId, message: 'hi' });
      claim = store.claimRequest();
    });
    if (!claim) throw new Error('claimRequest returned nothing');
    const depsRef: DepsRef = { current: { t: tStub, sessions: ctx, store } };
    await act(async () => {
      await runOneTurn(claim as ClaimedRequest, depsRef);
    });
  }

  it('lands the streamed deltas AND the done answer in a non-active session', async () => {
    const { latest } = captureStore();
    const store = latest();

    const bgId = 'session-bg';
    const pendingId = 'pending-bg';
    const fake = fakeSessions(
      [
        sessionWith('session-active', []), // the tab the user is looking at
        sessionWith(bgId, [streamingAssistant(pendingId)]),
      ],
      'session-active', // active tab is NOT the streaming one
    );

    // A delta, then the authoritative done answer — as two NDJSON lines.
    const body =
      `${JSON.stringify({ type: 'text_delta', text: 'partial ' })}\n` +
      `${JSON.stringify({
        type: 'done',
        answer: 'the complete answer',
        toolCalls: 0,
        iterations: 1,
      })}\n`;

    await driveInto(store, fake.ctx, bgId, pendingId, ndjson200(body));

    const msg = fake.session(bgId)?.messages.find((m) => m.id === pendingId);
    // Content is the done answer (mutation guard: 'partial ' alone or '' both fail).
    expect(msg?.content).toBe('the complete answer');
    // Turn is finalized on its own session, not left mid-stream.
    expect(msg?.streaming).toBe(false);
    // The active tab was never touched.
    expect(fake.session('session-active')?.messages).toHaveLength(0);
    // Persistence targeted the turn's session, never the active-tab helper.
    expect(fake.persistByIdSpy).toHaveBeenCalledWith(bgId);
    expect(fake.persistActiveSpy).not.toHaveBeenCalled();
  });
});
