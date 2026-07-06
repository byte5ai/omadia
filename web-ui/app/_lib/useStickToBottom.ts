'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Issue #404 — chat panes force-jumped to the bottom on every streamed
 * token, yanking the view back down whenever a user scrolled up to read
 * earlier messages. This hook gates the jump behind "is the user actually
 * at the bottom right now", matching Claude/ChatGPT's stick-to-bottom feel:
 *
 *   - at bottom (within `thresholdPx`)      -> keep following new content
 *   - user scrolls up                       -> detach, hold position
 *   - user scrolls back within the tolerance -> re-attach
 *   - `scrollToBottom()` (send a message)   -> force re-attach + jump
 *
 * The instant (non-smooth) jump is deliberate, not an oversight: smooth
 * scrolling can't keep pace with rapid token deltas — the animation
 * restarts further behind on every tick and never reaches the bottom.
 *
 * `isAtBottomRef` is the source of truth read on every `deps` change, so
 * scroll-position tracking never forces a re-render on its own. The
 * `isAtBottom` state mirror only updates when the value actually flips,
 * for the rare consumer (e.g. a "jump to bottom" button) that needs to
 * render off it.
 */
export function useStickToBottom<T extends HTMLElement>(
  scrollRef: RefObject<T | null>,
  deps: readonly unknown[],
  opts?: { thresholdPx?: number },
): { isAtBottom: boolean; scrollToBottom: () => void } {
  const thresholdPx = opts?.thresholdPx ?? 64;
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const computeIsAtBottom = useCallback(
    (el: T): boolean => {
      // No scrollbar (short transcript) counts as "at bottom" so it keeps
      // following once content grows past the fold.
      if (el.scrollHeight <= el.clientHeight) return true;
      return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
    },
    [thresholdPx],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleScroll = (): void => {
      const next = computeIsAtBottom(el);
      if (next !== isAtBottomRef.current) {
        isAtBottomRef.current = next;
        setIsAtBottom(next);
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollRef is a stable ref container
  }, [computeIsAtBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!isAtBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  return { isAtBottom, scrollToBottom };
}
