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

interface StatefulSessions {
  sessions: UseChatSessionsResult;
  /** Live transcript, so a test can assert the content actually landed. */
  get(id: string): ChatSession | undefined;
  /** Every id `runOneTurn` asked to persist, in call order. */
  persisted: string[];
}

function pendingMessage(): Message {
  return {
    id: 'pending-1',
    role: 'assistant',
    content: '',
    tools: [],
    startedAt: 1_000,
    streaming: true,
  };
}

/**
 * Stateful chat-sessions fake. A `vi.fn()`-only stub can assert that
 * `mutateById` was called but not that the answer arrived, which is precisely
 * the failure mode of #617 — so this one holds a real transcript and applies
 * the mutator with production semantics (`id` match, otherwise untouched).
 *
 * `activeId` is deliberately a session that is NOT the one being streamed:
 * that is the "user switched chat tabs mid-stream" situation.
 */
function statefulSessions(activeId = 'other'): StatefulSessions {
  let state: ChatSession[] = [
    {
      id: 'other',
      title: 'Foreground',
      createdAt: 1_000,
      updatedAt: 1_000,
      messages: [],
    },
    {
      id: 'bg',
      title: 'Background',
      createdAt: 1_000,
      updatedAt: 1_000,
      messages: [pendingMessage()],
    },
    {
      id: 'session-403',
      title: '#403',
      createdAt: 1_000,
      updatedAt: 1_000,
      messages: [pendingMessage()],
    },
  ];
  const persisted: string[] = [];

  const sessions = {
    activeId,
    mutateById(
      sessionId: string,
      mutator: (session: ChatSession) => ChatSession,
    ): void {
      state = state.map((s) => (s.id === sessionId ? mutator(s) : s));
    },
    persistById(sessionId: string): void {
      persisted.push(sessionId);
    },
  } as unknown as UseChatSessionsResult;

  return {
    sessions,
    get: (id: string) => state.find((s) => s.id === id),
    persisted,
  };
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
async function drive(
  store: StoreValue,
  response: Response,
  opts: { sessionId?: string; sessions?: StatefulSessions } = {},
): Promise<string> {
  const sessionId = opts.sessionId ?? 'session-403';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

  let claim: ClaimedRequest | undefined;
  await act(async () => {
    store.startTurn({ sessionId, pendingMessageId: 'pending-1', message: 'hi' });
    claim = store.claimRequest();
  });
  if (!claim) throw new Error('claimRequest returned nothing');

  const depsRef: DepsRef = {
    current: {
      t: tStub,
      sessions: (opts.sessions ?? statefulSessions()).sessions,
      store,
    },
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
 * OM-76 / OM-77 (#996, #997) — a 503 from the chat route used to reach the
 * bubble as the server's English sentence (`agent "default" is not currently
 * active`) or, worse, as a bare "HTTP 503". Both codes now map to a catalogue
 * key and flag the recovery banner with the cause.
 */
describe('runOneTurn — 503 agent codes are translated, never raw (OM-76/77)', () => {
  function json503(body: Record<string, unknown>): Response {
    return new Response(JSON.stringify(body), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('no_agents_active → errorNoAgentsActive + banner reason', async () => {
    const { latest } = captureStore();
    const store = latest();

    const sessionId = await drive(
      store,
      json503({
        error: 'no_agents_active',
        message: 'no orchestrator is active. Assign an LLM provider under LLM access.',
        slug: 'default',
      }),
    );

    const record = latest().get(sessionId);
    expect(record?.phase).toBe('error');
    expect(record?.error).toBe('errorNoAgentsActive');
    expect(record?.error).not.toMatch(/HTTP 503|is not currently active|no orchestrator is active/);
    expect(record?.agentUnavailableReason).toBe('no_agents_active');
    expect(record?.agentUnavailableSlug).toBe('default');
  });

  it('agent_unavailable → errorAgentUnavailable + banner reason', async () => {
    const { latest } = captureStore();
    const store = latest();

    const sessionId = await drive(
      store,
      json503({
        error: 'agent_unavailable',
        message: 'agent "sales" is not currently active',
        slug: 'sales',
      }),
    );

    const record = latest().get(sessionId);
    expect(record?.phase).toBe('error');
    expect(record?.error).toBe('errorAgentUnavailable');
    expect(record?.error).not.toMatch(/HTTP 503|is not currently active/);
    expect(record?.agentUnavailableReason).toBe('agent_unavailable');
    expect(record?.agentUnavailableSlug).toBe('sales');
  });
});

/**
 * #617 — a turn whose session is NOT the active one used to write into the
 * void: every store write went through the active-session mutator, so the
 * answer arrived in the tab marker but never in the transcript. These tests drive a real
 * background turn ('bg' streaming while 'other' is active) against a stateful
 * sessions fake and assert the content landed.
 */
describe('runOneTurn — background session (#617)', () => {
  it('folds a background turn into its own session, not the active one', async () => {
    const { latest } = captureStore();
    const store = latest();
    const fake = statefulSessions('other');

    const body = [
      JSON.stringify({ type: 'text_delta', text: 'partial ' }),
      JSON.stringify({ type: 'text_delta', text: 'stream' }),
      JSON.stringify({
        type: 'done',
        answer: 'the authoritative answer',
        toolCalls: 0,
        iterations: 1,
      }),
      '',
    ].join('\n');

    await drive(store, ndjson200(body), { sessionId: 'bg', sessions: fake });

    const pending = fake.get('bg')?.messages[0];
    expect(pending?.content).toBe('the authoritative answer');
    expect(pending?.streaming).toBe(false);
    // The active session must not have been touched at all.
    expect(fake.get('other')?.messages).toHaveLength(0);
  });

  it('keeps the streamed deltas when the stream ends without a done event', async () => {
    const { latest } = captureStore();
    const store = latest();
    const fake = statefulSessions('other');

    const body = [
      JSON.stringify({ type: 'text_delta', text: 'half an ' }),
      JSON.stringify({ type: 'text_delta', text: 'answer' }),
      '',
    ].join('\n');

    await drive(store, ndjson200(body), { sessionId: 'bg', sessions: fake });

    const pending = fake.get('bg')?.messages[0];
    expect(pending?.content).toBe('half an answer');
    // finalizePending must clear the flag even without `done`, otherwise the
    // bubble animates its dots forever.
    expect(pending?.streaming).toBe(false);
  });

  it('persists the session the turn belongs to', async () => {
    const { latest } = captureStore();
    const store = latest();
    const fake = statefulSessions('other');

    const body = `${JSON.stringify({
      type: 'done',
      answer: 'persisted',
      toolCalls: 0,
      iterations: 1,
    })}\n`;

    await drive(store, ndjson200(body), { sessionId: 'bg', sessions: fake });

    expect(fake.persisted).toEqual(['bg']);
    expect(fake.persisted).not.toContain('other');
  });
});
