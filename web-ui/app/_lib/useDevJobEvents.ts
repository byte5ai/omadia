'use client';

import { useEffect, useRef } from 'react';

/**
 * Epic #470 W0 — subscribe to the single job-event SSE tail
 * (`GET /api/v1/admin/dev-platform/jobs/:id/events`, spec §9). Modeled 1:1 on
 * `useSpecEvents.ts`: one `EventSource` with `withCredentials`, named listeners
 * per event type, the handler stored in a ref so re-renders never tear the
 * connection, and browser auto-reconnect. `onStatus` feeds the connection line.
 *
 * The server sets each message's `id:` to the `dev_job_events.id` identity
 * column, so the browser's `Last-Event-ID` reconnect resumes losslessly across
 * runner provisions (spec §9). Every payload is the full `DevJobEvent` JSON.
 */

/** The wire shape of one stored event (`DevJobEvent` in the middleware types). */
export interface DevJobEventMessage {
  id: number;
  jobId: string;
  provision: number;
  seq: number;
  type: DevJobEventName;
  ts: string;
  payload: Record<string, unknown>;
}

export type DevJobEventName =
  | 'log'
  | 'tool'
  | 'status'
  | 'heartbeat'
  | 'egress'
  | 'token'
  | 'gate'
  | 'phase'
  | 'approval';

/** The named listeners we bind (all events arrive as the same JSON envelope). */
const EVENT_NAMES: readonly DevJobEventName[] = [
  'log',
  'tool',
  'status',
  'heartbeat',
  'egress',
  'token',
  'gate',
  'phase',
  'approval',
];

interface UseDevJobEventsOptions {
  /** Disable the subscription entirely (e.g. a terminal job with no live tail). */
  enabled?: boolean;
  /** Connection-state callback: `'open'` / `'closed'` / `'error'`. */
  onStatus?: (status: 'open' | 'closed' | 'error') => void;
}

export function useDevJobEvents(
  jobId: string,
  handler: (ev: DevJobEventMessage) => void,
  opts: UseDevJobEventsOptions = {},
): void {
  // Latest-value refs so the subscription effect doesn't tear down the
  // EventSource on every render (mirrors useSpecEvents).
  const handlerRef = useRef<((ev: DevJobEventMessage) => void) | null>(null);
  const onStatusRef = useRef<UseDevJobEventsOptions['onStatus']>(undefined);
  useEffect(() => {
    handlerRef.current = handler;
    onStatusRef.current = opts.onStatus;
  });

  const enabled = opts.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    if (!jobId) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    const url = `/bot-api/v1/admin/dev-platform/jobs/${encodeURIComponent(jobId)}/events`;
    const source = new EventSource(url, { withCredentials: true });

    const onOpen = (): void => {
      onStatusRef.current?.('open');
    };
    const onError = (): void => {
      // EventSource auto-reconnects unless readyState === CLOSED (2).
      onStatusRef.current?.(source.readyState === 2 ? 'closed' : 'error');
    };
    const dispatch = (e: MessageEvent<string>): void => {
      try {
        handlerRef.current?.(JSON.parse(e.data) as DevJobEventMessage);
      } catch {
        // ignore malformed
      }
    };

    source.addEventListener('open', onOpen);
    source.addEventListener('error', onError);
    for (const name of EVENT_NAMES) {
      source.addEventListener(name, dispatch as EventListener);
    }

    return () => {
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      for (const name of EVENT_NAMES) {
        source.removeEventListener(name, dispatch as EventListener);
      }
      source.close();
      onStatusRef.current?.('closed');
    };
  }, [jobId, enabled]);
}
