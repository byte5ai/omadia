'use client';

import { useEffect, useRef } from 'react';

import type { SpecBusEvent } from '../../../../_lib/builderTypes';

interface UseSpecEventsOptions {
  /** Disable the subscription entirely (e.g. while a tab is hidden). */
  enabled?: boolean;
  /** Optional connection-state callback. `'open'` / `'closed'` / `'error'`. */
  onStatus?: (status: 'open' | 'closed' | 'error') => void;
}

/**
 * Subscribe to the per-draft SpecEventBus stream (B.5-4) — every spec_patch,
 * slot_patch and lint_result emitted server-side, regardless of whether the
 * cause was `agent` (BuilderAgent tool calls) or `user` (inline-editor
 * PATCH endpoints). Two open tabs editing the same draft both subscribe and
 * see each other's mutations live, without any chat-stream involvement.
 *
 * EventSource handles auto-reconnect for us; we just need to add the named
 * listeners + clean up on unmount. The handler is stored in a ref so the
 * effect doesn't tear down the connection on every render.
 */
export function useSpecEvents(
  draftId: string,
  handler: (ev: SpecBusEvent) => void,
  opts: UseSpecEventsOptions = {},
): void {
  // Latest-value refs so the subscription effect below doesn't tear down the
  // EventSource on every render. Synced via a post-render effect (never during
  // render) to satisfy the React-Compiler `refs` rule; lazily initialised so
  // `.current` isn't treated as a frozen hook argument by `immutability`. Every
  // consumer (`dispatch`, `onOpen`/`onError`, cleanup) runs asynchronously
  // after commit, so the ref is always populated by the time it is read.
  const handlerRef = useRef<((ev: SpecBusEvent) => void) | null>(null);
  const onStatusRef = useRef<UseSpecEventsOptions['onStatus']>(undefined);
  useEffect(() => {
    handlerRef.current = handler;
    onStatusRef.current = opts.onStatus;
  });

  const enabled = opts.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    const url = `/bot-api/v1/builder/drafts/${encodeURIComponent(draftId)}/events`;
    const source = new EventSource(url, { withCredentials: true });

    const onOpen = (): void => {
      onStatusRef.current?.('open');
    };
    const onError = (): void => {
      // EventSource auto-reconnects unless readyState === CLOSED.
      onStatusRef.current?.(source.readyState === 2 ? 'closed' : 'error');
    };
    const dispatch = (ev: SpecBusEvent): void => {
      handlerRef.current?.(ev);
    };

    const onSpecPatch = (e: MessageEvent<string>): void => {
      try {
        dispatch(JSON.parse(e.data) as SpecBusEvent);
      } catch {
        // ignore malformed
      }
    };
    const onSlotPatch = onSpecPatch;
    const onLint = onSpecPatch;

    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    source.addEventListener('spec_patch', onSpecPatch as EventListener);
    source.addEventListener('slot_patch', onSlotPatch as EventListener);
    source.addEventListener('lint_result', onLint as EventListener);
    // B.6-6 — out-of-band rebuild status. Same JSON envelope, just a
    // different event name so callers can route it to the build-status
    // surface without poking at the union discriminator twice.
    source.addEventListener('build_status', onSpecPatch as EventListener);

    return () => {
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      source.removeEventListener('spec_patch', onSpecPatch as EventListener);
      source.removeEventListener('slot_patch', onSlotPatch as EventListener);
      source.removeEventListener('lint_result', onLint as EventListener);
      source.removeEventListener('build_status', onSpecPatch as EventListener);
      source.close();
      onStatusRef.current?.('closed');
    };
  }, [draftId, enabled]);
}
