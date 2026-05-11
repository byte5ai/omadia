'use client';

import { useEffect, useState } from 'react';

/**
 * SSR-safe useMediaQuery hook. Returns `false` on the server (no
 * `window`) and during the first browser render so the markup matches —
 * then re-evaluates against the live `MediaQueryList` once mounted.
 *
 * Re-uses the `MediaQueryList.addEventListener('change', …)` API rather
 * than polling so subscriptions piggy-back on the browser's own layout-
 * boundary notifications. The `change` callback only fires when the
 * boolean *flips*, so this is cheap to mount in many components.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const listener = (ev: MediaQueryListEvent): void => setMatches(ev.matches);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [query]);

  return matches;
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
