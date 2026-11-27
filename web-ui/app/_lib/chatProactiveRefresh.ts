'use client';

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

import { mergeProactiveFromRemote } from './chatProactiveMerge';
import type { ChatSession } from './chatSessions';

/**
 * #1071 — the live side of routine delivery for `useChatSessions`: re-read a
 * chat, fold the deliveries it carries into the local copy, and never let a
 * server copy requested before (or while) a clear bring cleared deliveries
 * back.
 *
 * The chat page calls
 * `refreshProactive` when it mounts, when hydration finishes and when the
 * active chat changes; this hook itself re-reads the active chat when the
 * tab becomes visible again and when the window regains focus (a desktop /
 * Electron window can be refocused without ever turning hidden), on a 60 s
 * poll, and — #2354 — at once when the chat's delivery stream signals a
 * delivery. PUT answers
 * (the server merges deliveries into every PUT) are folded through
 * `foldProactive` too.
 *
 * A fold is not a local edit. Every omadia tab mounts the chat-sessions
 * provider, so a tab loaded long ago folds a delivery the moment it regains
 * focus — and its in-memory sessions predate whatever other tabs stored
 * since. Writing that whole array would roll their turns back and bring
 * chats they deleted back to life (hydration would even re-create them on the
 * server). So a fold persists only the delivery, into the ONE stored chat it
 * belongs to (`persistFold`), and `isFoldOnlyChange` lets the caller skip its
 * whole-array localStorage write for a state change made of folds alone.
 */
export interface ProactiveRefreshDeps {
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  hydrating: boolean;
  /** The chat to re-read on visibility change / focus ('' while there is none). */
  activeId: string;
  /** Reads one chat from the server; `null` when it does not exist. */
  fetchSession: (id: string) => Promise<ChatSession | null>;
  /**
   * Persists a fold: adds the deliveries of `remote` to the STORED copy of
   * chat `id` only, never re-writing any other chat.
   */
  persistFold: (id: string, remote: ChatSession) => void;
}

export interface ProactiveRefresh {
  /** The chat's clear epoch — capture it when requesting a server copy. */
  clearEpochOf(id: string): number;
  /**
   * Mark a clear as started: every server copy requested before now is
   * stale, and nothing is folded into this chat until `endClear`.
   */
  beginClear(id: string): void;
  /**
   * Mark a clear as finished (the server reset completed or failed): server
   * copies requested while it ran are stale too.
   */
  endClear(id: string): void;
  /** Fold a server copy requested at `epoch` into the local chat. */
  foldProactive(id: string, remote: ChatSession, epoch: number): void;
  /** Re-read a chat and fold in its deliveries. Never PUTs. */
  refreshProactive(id: string): void;
  /**
   * `next` differs from `prev` only by folds (same chats, same order, every
   * changed chat is a fold result) — nothing this tab needs to write whole.
   */
  isFoldOnlyChange(prev: readonly ChatSession[], next: readonly ChatSession[]): boolean;
}

/** #2354 — the delivery stream of one chat (`GET …/sessions/:id/events`). */
export function deliveryEventsUrl(id: string): string {
  return `/bot-api/chat/sessions/${encodeURIComponent(id)}/events`;
}

/** #2354 — wait before re-opening a delivery stream the browser closed. */
export const DELIVERY_EVENTS_RETRY_MS = 15_000;

/**
 * #2354 — subscribe to a chat's delivery signals; `undefined` where the
 * browser has no `EventSource` (tests, old engines), which leaves the poll.
 *
 * A stream answered with an error status is closed by the browser for good
 * (it retries only dropped connections). That is the normal case for a chat
 * that is not stored yet (404 until its first PUT), so a closed stream is
 * opened again after {@link DELIVERY_EVENTS_RETRY_MS}.
 */
function openDeliveryEvents(id: string, onDelivery: () => void): { close(): void } | undefined {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return undefined;
  let source: EventSource | undefined;
  let retry: number | undefined;
  let closed = false;
  const open = (): void => {
    source = new EventSource(deliveryEventsUrl(id), { withCredentials: true });
    source.addEventListener('delivery', onDelivery);
    source.addEventListener('error', () => {
      if (closed || source?.readyState !== EventSource.CLOSED) return;
      retry = window.setTimeout(open, DELIVERY_EVENTS_RETRY_MS);
    });
  };
  open();
  return {
    close(): void {
      closed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      source?.close();
    },
  };
}

/** #1755 — how often a visible chat re-reads its deliveries. */
export const PROACTIVE_POLL_MS = 60_000;

export function useProactiveRefresh(deps: ProactiveRefreshDeps): ProactiveRefresh {
  const { setSessions, hydrating, activeId, fetchSession, persistFold } = deps;

  // Per-session clear epoch. A re-read or PUT answer requested before a
  // clear still carries the deliveries the user just cleared; folding it in
  // would bring them back (and the next PUT would persist them).
  const clearEpochRef = useRef<Map<string, number>>(new Map());
  // Chats whose server reset is still in flight. A server copy requested
  // AFTER the clear started but answered BEFORE the reset landed carries the
  // same epoch as a post-clear request, yet still holds the cleared
  // deliveries — so nothing is folded while a clear runs.
  const clearingRef = useRef<Map<string, number>>(new Map());
  const clearEpochOf = useCallback(
    (id: string): number => clearEpochRef.current.get(id) ?? 0,
    [],
  );
  const bumpClearEpoch = useCallback(
    (id: string): void => {
      clearEpochRef.current.set(id, clearEpochOf(id) + 1);
    },
    [clearEpochOf],
  );
  const beginClear = useCallback(
    (id: string): void => {
      bumpClearEpoch(id);
      clearingRef.current.set(id, (clearingRef.current.get(id) ?? 0) + 1);
    },
    [bumpClearEpoch],
  );
  const endClear = useCallback(
    (id: string): void => {
      bumpClearEpoch(id);
      const running = (clearingRef.current.get(id) ?? 1) - 1;
      if (running <= 0) clearingRef.current.delete(id);
      else clearingRef.current.set(id, running);
    },
    [bumpClearEpoch],
  );

  // Maps each session object a fold produced to the object it was folded
  // from. A state change is made of folds alone (`isFoldOnlyChange`) only when
  // every changed chat leads back through this chain to its previous object:
  // a fold applied on top of another edit (a settled title, batched into the
  // same render) must still be written whole.
  const foldedFromRef = useRef<WeakMap<ChatSession, ChatSession>>(new WeakMap());

  // Additive only (`mergeProactiveFromRemote`), and a session with a turn in
  // flight is left alone — the stream owns that state until it finishes.
  // When nothing was folded the previous array is returned as-is, so a
  // re-read that finds no delivery causes no re-render. What IS folded is
  // persisted into the stored copy of this one chat (`persistFold`), never
  // by re-writing this tab's whole — possibly stale — session array.
  const foldProactive = useCallback(
    (id: string, remote: ChatSession, epoch: number): void => {
      if (clearEpochOf(id) !== epoch || clearingRef.current.has(id)) return;
      setSessions((prev) => {
        const next = prev.map((s) => {
          if (s.id !== id || s.messages.some((m) => m.streaming === true)) return s;
          const merged = mergeProactiveFromRemote(s, remote);
          if (merged !== s) foldedFromRef.current.set(merged, s);
          return merged;
        });
        return next.every((s, i) => s === prev[i]) ? prev : next;
      });
      persistFold(id, remote);
    },
    [clearEpochOf, setSessions, persistFold],
  );

  const isFoldOnlyChange = useCallback(
    (prev: readonly ChatSession[], next: readonly ChatSession[]): boolean => {
      const foldedFrom = foldedFromRef.current;
      const reachedByFolds = (s: ChatSession, before: ChatSession | undefined): boolean => {
        for (let cur: ChatSession | undefined = s; cur !== undefined; cur = foldedFrom.get(cur)) {
          if (cur === before) return true;
        }
        return false;
      };
      return prev.length === next.length && next.every((s, i) => reachedByFolds(s, prev[i]));
    },
    [],
  );

  const refreshProactive = useCallback(
    (id: string): void => {
      if (!id) return;
      const epoch = clearEpochOf(id);
      fetchSession(id)
        .then((remote) => {
          if (remote) foldProactive(id, remote, epoch);
        })
        .catch((err: unknown) => {
          console.warn(
            '[chat-sessions] proactive refresh failed:',
            err instanceof Error ? err.message : err,
          );
        });
    },
    [clearEpochOf, fetchSession, foldProactive],
  );

  useEffect(() => {
    if (hydrating || !activeId) return;
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refreshProactive(activeId);
    };
    // Switching back to a browser tab fires both events; the second re-read
    // finds nothing new and changes no state (see `foldProactive`).
    const onFocus = (): void => {
      refreshProactive(activeId);
    };
    // #1755 — a tab that stays visible without regaining focus (a second
    // monitor, a kiosk) still gets a delivery: a light poll while visible.
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshProactive(activeId);
    }, PROACTIVE_POLL_MS);
    // #2354 (ADR-0321) — a delivery into the open chat arrives at once: the
    // middleware signals it on the chat's event stream (a signal only, never
    // the text) and the chat is re-read through the owner-checked GET. The
    // poll above stays as the fallback (stream down, another process).
    const events = openDeliveryEvents(activeId, () => refreshProactive(activeId));
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      events?.close();
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [hydrating, activeId, refreshProactive]);

  return {
    clearEpochOf,
    beginClear,
    endClear,
    foldProactive,
    refreshProactive,
    isFoldOnlyChange,
  };
}
