'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * SSR-safe useMediaQuery hook. Returns `false` on the server (no
 * `window`) and during hydration so the markup matches — then
 * re-evaluates against the live `MediaQueryList` once mounted.
 *
 * Backed by `useSyncExternalStore`: the `MediaQueryList` `change` event is
 * the subscription and `mql.matches` is the snapshot, so the boolean is
 * read directly during render instead of being mirrored into an effect.
 * The `change` callback only fires when the boolean *flips*, so this is
 * cheap to mount in many components.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) {
        return () => {};
      }
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onStoreChange);
      return () => mql.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback((): boolean => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * Convenience: matches the master-plan B.6 breakpoint for "desktop = full
 * 3-pane workspace, mobile = single-pane + tab nav". 1280px is the
 * minimum width at which the 3-pane grid is comfortable; below that the
 * panes would each be < ~400px and the chat input + Monaco editor both
 * become uncomfortable.
 */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 1280px)');
}
