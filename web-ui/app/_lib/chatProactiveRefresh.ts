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
 * There is no live push for the web chat, so the chat page calls
 * `refreshProactive` when it mounts, when hydration finishes and when the
 * active chat changes; this hook itself re-reads the active chat when the
 * tab becomes visible again and when the window regains focus (a desktop /
 * Electron window can be refocused without ever turning hidden). PUT answers
 * (the server merges deliveries into every PUT) are folded through
 * `foldProactive` too.
 */
export interface ProactiveRefreshDeps {
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  hydrating: boolean;
  /** The chat to re-read on visibility change / focus ('' while there is none). */
  activeId: string;
  /** Reads one chat from the server; `null` when it does not exist. */
  fetchSession: (id: string) => Promise<ChatSession | null>;
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
}

export function useProactiveRefresh(deps: ProactiveRefreshDeps): ProactiveRefresh {
  const { setSessions, hydrating, activeId, fetchSession } = deps;

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

  // Additive only (`mergeProactiveFromRemote`), and a session with a turn in
  // flight is left alone — the stream owns that state until it finishes.
  // When nothing was folded the previous array is returned as-is, so a
  // re-read that finds no delivery causes no re-render and no localStorage
  // write — a stale tab regaining focus must not overwrite what another tab
  // stored meanwhile.
  const foldProactive = useCallback(
    (id: string, remote: ChatSession, epoch: number): void => {
      if (clearEpochOf(id) !== epoch || clearingRef.current.has(id)) return;
      setSessions((prev) => {
        const next = prev.map((s) =>
          s.id === id && !s.messages.some((m) => m.streaming === true)
            ? mergeProactiveFromRemote(s, remote)
            : s,
        );
        return next.every((s, i) => s === prev[i]) ? prev : next;
      });
    },
    [clearEpochOf, setSessions],
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
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [hydrating, activeId, refreshProactive]);

  return { clearEpochOf, beginClear, endClear, foldProactive, refreshProactive };
}
