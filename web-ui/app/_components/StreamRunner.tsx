'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

import { applyStreamEvent, type ChatStreamEvent } from '../_lib/chatStreamEvents';
import { useChatSessionsCtx } from '../_lib/chatSessionsContext';
import {
  type ClaimedRequest,
  type StreamPhase,
  useStreamStore,
} from '../_lib/streamStore';

/**
 * Headless background runner for chat streams. Mounted once in the layout;
 * watches the streamStore's pending-request queue, takes ownership of each
 * request, runs the fetch + NDJSON-parse loop, and writes message deltas
 * back into the chat-sessions context.
 *
 * Why headless and at layout level: ChatPage unmounts on menu navigation
 * (e.g. Chat → Graph). If the stream loop lived inside ChatPage, that
 * navigation would kill the fetch. Lifting both the loop and the session
 * state into the layout fixes that — the runner keeps pumping events and
 * the session store keeps receiving them, regardless of which route the
 * user is currently looking at.
 */
export function StreamRunner(): null {
  const t = useTranslations('chat');
  const store = useStreamStore();
  const sessions = useChatSessionsCtx();
  const inFlight = useRef<Set<string>>(new Set());

  // Snapshot dependencies so the async loop doesn't capture stale closures
  // when next-intl re-renders mid-stream.
  const depsRef = useRef({ t, sessions, store });
  useEffect(() => {
    depsRef.current = { t, sessions, store };
  }, [t, sessions, store]);

  useEffect(() => {
    let cancelled = false;

    const drain = (): void => {
      while (!cancelled) {
        const claim = store.claimRequest();
        if (!claim) return;
        if (inFlight.current.has(claim.request.sessionId)) continue;
        inFlight.current.add(claim.request.sessionId);
        void (async (): Promise<void> => {
          try {
            await runOneTurn(claim, depsRef);
          } finally {
            inFlight.current.delete(claim.request.sessionId);
          }
        })();
      }
    };

    drain();
    return () => {
      cancelled = true;
    };
  }, [store, store.queueVersion]);

  return null;
}

interface DepsRef {
  current: {
    t: ReturnType<typeof useTranslations>;
    sessions: ReturnType<typeof useChatSessionsCtx>;
    store: ReturnType<typeof useStreamStore>;
  };
}

async function runOneTurn(claim: ClaimedRequest, depsRef: DepsRef): Promise<void> {
  const { request, signal } = claim;
  const { sessionId, pendingMessageId, message, agentSlug } = request;
  const { store } = depsRef.current;

  // Per-turn accumulators. Kept local to the runner so the store stays
  // thin — it just receives the resulting patches. The content buffer
  // powers a rolling preview tail that survives multiple `text_delta`
  // chunks (otherwise the toast would only ever show the last delta).
  let contentBuffer = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheTokens = 0;

  const applyEvent = (event: ChatStreamEvent): void => {
    const { sessions: liveSessions } = depsRef.current;
    applyStreamEvent(liveSessions, sessionId, pendingMessageId, event);

    // Accumulate per-turn signals BEFORE deriving the patch so the
    // patch has fresh numbers.
    if (event.type === 'text_delta') {
      contentBuffer += event.text;
    } else if (event.type === 'iteration_usage') {
      tokensIn += event.inputTokens;
      tokensOut += event.outputTokens;
      cacheTokens += event.cacheReadInputTokens;
    } else if (event.type === 'done') {
      // The `done` event carries the authoritative answer; the live
      // text_delta buffer can legitimately be shorter than this (e.g.
      // Privacy Shield v4 server-side materialization). Mirror it so
      // toasts that linger after `done` show the real final text.
      contentBuffer = event.answer;
    }

    const phasePatch = derivePhasePatch(event, {
      contentBuffer,
      tokensIn,
      tokensOut,
      cacheTokens,
    });
    if (phasePatch) store.patch(sessionId, phasePatch);
  };

  try {
    const res = await fetch('/bot-api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        sessionId,
        ...(agentSlug ? { agentSlug } : {}),
      }),
      signal,
    });

    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !res.body) {
      const fallback = await res.text().catch(() => '');
      const looksHtml =
        fallback.trimStart().toLowerCase().startsWith('<!doctype') ||
        fallback.trimStart().startsWith('<html');
      const { t } = depsRef.current;
      let msg: string;
      if (looksHtml || contentType.includes('text/html')) {
        msg =
          res.status === 500
            ? t('errorMiddlewareUnreachable')
            : t('errorProxyFailure', { status: String(res.status) });
      } else if (contentType.includes('application/json')) {
        try {
          const parsed = JSON.parse(fallback) as {
            error?: string;
            message?: string;
            slug?: string;
          };
          msg = parsed.message ?? parsed.error ?? `HTTP ${String(res.status)}`;
          // Phase A / TA08 — flag the recovery banner.
          if (
            res.status === 503 &&
            parsed.error === 'agent_unavailable' &&
            parsed.slug
          ) {
            store.patch(sessionId, { agentUnavailableSlug: parsed.slug });
          }
        } catch {
          msg = fallback || `HTTP ${String(res.status)}`;
        }
      } else {
        msg = fallback || `HTTP ${String(res.status)}`;
      }
      applyEvent({ type: 'error', message: msg });
      store.finish(sessionId, 'error', msg);
      finalizePending(depsRef.current.sessions, sessionId, pendingMessageId);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        try {
          const event = JSON.parse(trimmedLine) as ChatStreamEvent;
          applyEvent(event);
        } catch {
          // Partial NDJSON tail stays in buffer.
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        applyEvent(JSON.parse(tail) as ChatStreamEvent);
      } catch {
        /* ignore */
      }
    }
    store.finish(sessionId, 'done');
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      const { t } = depsRef.current;
      applyEvent({ type: 'error', message: t('errorAborted') });
      store.finish(sessionId, 'aborted');
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      applyEvent({ type: 'error', message: msg });
      store.finish(sessionId, 'error', msg);
    }
  } finally {
    finalizePending(depsRef.current.sessions, sessionId, pendingMessageId);
    void depsRef.current.sessions.persistActive();
  }
}

function finalizePending(
  sessions: ReturnType<typeof useChatSessionsCtx>,
  sessionId: string,
  pendingMessageId: string,
): void {
  sessions.mutateActive((session) => {
    if (session.id !== sessionId) return session;
    return {
      ...session,
      messages: session.messages.map((m) =>
        m.id === pendingMessageId && m.streaming
          ? { ...m, streaming: false, finishedAt: Date.now() }
          : m,
      ),
      updatedAt: Date.now(),
    };
  });
}

interface AccumulatorState {
  contentBuffer: string;
  tokensIn: number;
  tokensOut: number;
  cacheTokens: number;
}

function derivePhasePatch(
  event: ChatStreamEvent,
  acc: AccumulatorState,
): {
  phase?: StreamPhase;
  previewTail?: string;
  toolName?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheTokens?: number;
} | null {
  switch (event.type) {
    case 'text_delta':
      return {
        phase: 'streaming',
        previewTail: tailOf(acc.contentBuffer),
      };
    case 'tool_use':
      return { phase: 'tool_running', toolName: event.name };
    case 'tool_result':
      return { phase: 'thinking', toolName: undefined };
    case 'iteration_usage':
      return {
        tokensIn: acc.tokensIn,
        tokensOut: acc.tokensOut,
        cacheTokens: acc.cacheTokens,
      };
    case 'done':
      return {
        previewTail: tailOf(acc.contentBuffer),
        tokensIn: acc.tokensIn,
        tokensOut: acc.tokensOut,
        cacheTokens: acc.cacheTokens,
      };
    case 'heartbeat':
      if (event.phase) return { phase: mapHeartbeatPhase(event.phase) };
      return null;
    case 'iteration_start':
      return { phase: 'thinking' };
    default:
      return null;
  }
}

function mapHeartbeatPhase(
  phase: 'thinking' | 'streaming' | 'tool_running' | 'idle',
): StreamPhase {
  switch (phase) {
    case 'thinking':
      return 'thinking';
    case 'streaming':
      return 'streaming';
    case 'tool_running':
      return 'tool_running';
    case 'idle':
      return 'streaming';
  }
}

/** Last ~160 chars of normalized text, sliced at a word boundary so the
 *  toast never opens mid-word (otherwise we'd routinely see "ach den…"
 *  when the buffer was cut from "nach den…"). Prefixes an ellipsis when
 *  the original was actually trimmed. */
function tailOf(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  const MAX = 160;
  if (single.length <= MAX) return single;
  const sliced = single.slice(-MAX);
  // Drop everything up to (and including) the first space so the tail
  // starts with a whole word.
  const firstSpace = sliced.indexOf(' ');
  const cleaned = firstSpace >= 0 ? sliced.slice(firstSpace + 1) : sliced;
  return `…${cleaned}`;
}
