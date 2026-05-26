'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Process-wide registry of active chat streams. Lives at the layout level
 * so a stream survives ChatPage unmount (menu-switch) or ChatTabs switch.
 * The fetch + NDJSON-parse loop is owned by <StreamRunner /> (also mounted
 * in the layout); this store is the orchestration layer between the UI
 * (start/abort/observe) and the runner (consumes pending requests, reports
 * lifecycle).
 *
 * The store never holds the full message buffer — that lives in
 * ChatSessions (localStorage + backend). What we keep here is the
 * lightweight "is something happening, and what does the preview look
 * like?" state needed for tabs, toasts, and stop buttons.
 */

export type StreamPhase =
  | 'pending'
  | 'thinking'
  | 'streaming'
  | 'tool_running'
  | 'done'
  | 'error'
  | 'aborted';

/** Lightweight per-stream record. Snapshotted at every mutation so React
 *  can shallow-compare. The AbortController is intentionally hidden — only
 *  the store mutates it (via abort()) and only the runner reads it (via
 *  claimRequest()). */
export interface StreamRecord {
  sessionId: string;
  phase: StreamPhase;
  startedAt: number;
  lastEventAt: number;
  previewTail: string;
  toolName?: string;
  error?: string;
  /** Wall-clock at which this terminal record may be GC'd. */
  expiresAt?: number;
}

/** Payload the UI hands the store to ask <StreamRunner /> to do the work. */
export interface StreamRequest {
  sessionId: string;
  pendingMessageId: string;
  message: string;
}

/** What the runner pulls off the queue. */
export interface ClaimedRequest {
  request: StreamRequest;
  signal: AbortSignal;
}

interface InternalRecord extends StreamRecord {
  controller: AbortController;
}

interface StreamStoreContextValue {
  records: ReadonlyMap<string, StreamRecord>;
  /** Bump on every queue change so the runner's effect re-fires. */
  queueVersion: number;
  /** UI entry point — fires off a new turn. Returns false if the session
   *  already has an in-flight stream. */
  startTurn(req: StreamRequest): boolean;
  /** Runner pulls the next unclaimed request, atomically marking it
   *  claimed. Returns undefined if nothing pending. */
  claimRequest(): ClaimedRequest | undefined;
  /** Runner updates the record as events stream in. */
  patch(sessionId: string, patch: Partial<Omit<StreamRecord, 'sessionId'>>): void;
  /** Runner reports the terminal outcome. */
  finish(
    sessionId: string,
    outcome: 'done' | 'error' | 'aborted',
    error?: string,
  ): void;
  /** User-initiated abort. Synchronous — flips phase immediately. */
  abort(sessionId: string): void;
  /** Inspect the record for a session. */
  get(sessionId: string): StreamRecord | undefined;
  /** True while the session has a non-terminal stream. */
  isActive(sessionId: string): boolean;
}

const Ctx = createContext<StreamStoreContextValue | null>(null);

/** Max number of records the store retains (active + recently terminated). */
const MAX_RECORDS = 12;
/** Time after which a terminal record is garbage-collected. */
const GC_AFTER_MS = 5 * 60 * 1000;
/** Periodic GC sweep interval. */
const GC_SWEEP_MS = 30 * 1000;

function isTerminal(phase: StreamPhase): boolean {
  return phase === 'done' || phase === 'error' || phase === 'aborted';
}

export function StreamStoreProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const internalRef = useRef<Map<string, InternalRecord>>(new Map());
  const pendingRef = useRef<StreamRequest[]>([]);
  const [records, setRecords] = useState<ReadonlyMap<string, StreamRecord>>(
    new Map(),
  );
  const [queueVersion, setQueueVersion] = useState(0);

  const publishSnapshot = useCallback((): void => {
    const snapshot = new Map<string, StreamRecord>();
    for (const [k, v] of internalRef.current.entries()) {
      const { controller: _drop, ...rest } = v;
      snapshot.set(k, rest);
    }
    setRecords(snapshot);
  }, []);

  const bumpQueue = useCallback((): void => {
    setQueueVersion((v) => v + 1);
  }, []);

  const evictIfOverCapacity = useCallback((): void => {
    if (internalRef.current.size <= MAX_RECORDS) return;
    const terminated = [...internalRef.current.entries()]
      .filter(([, r]) => isTerminal(r.phase))
      .sort((a, b) => a[1].lastEventAt - b[1].lastEventAt);
    while (internalRef.current.size > MAX_RECORDS && terminated.length > 0) {
      const oldest = terminated.shift();
      if (!oldest) break;
      internalRef.current.delete(oldest[0]);
    }
  }, []);

  const startTurn = useCallback(
    (req: StreamRequest): boolean => {
      const existing = internalRef.current.get(req.sessionId);
      if (existing && !isTerminal(existing.phase)) return false;
      const controller = new AbortController();
      const now = Date.now();
      internalRef.current.set(req.sessionId, {
        sessionId: req.sessionId,
        phase: 'pending',
        startedAt: now,
        lastEventAt: now,
        previewTail: '',
        controller,
      });
      pendingRef.current = [
        ...pendingRef.current.filter((r) => r.sessionId !== req.sessionId),
        req,
      ];
      evictIfOverCapacity();
      publishSnapshot();
      bumpQueue();
      return true;
    },
    [bumpQueue, evictIfOverCapacity, publishSnapshot],
  );

  const claimRequest = useCallback((): ClaimedRequest | undefined => {
    if (pendingRef.current.length === 0) return undefined;
    const [next, ...rest] = pendingRef.current;
    if (!next) return undefined;
    pendingRef.current = rest;
    const record = internalRef.current.get(next.sessionId);
    if (!record) {
      bumpQueue();
      return undefined;
    }
    bumpQueue();
    return { request: next, signal: record.controller.signal };
  }, [bumpQueue]);

  const patch = useCallback(
    (sessionId: string, patchData: Partial<Omit<StreamRecord, 'sessionId'>>): void => {
      const existing = internalRef.current.get(sessionId);
      if (!existing) return;
      internalRef.current.set(sessionId, {
        ...existing,
        ...patchData,
        sessionId,
        controller: existing.controller,
        lastEventAt: patchData.lastEventAt ?? Date.now(),
      });
      publishSnapshot();
    },
    [publishSnapshot],
  );

  const finish = useCallback(
    (
      sessionId: string,
      outcome: 'done' | 'error' | 'aborted',
      error?: string,
    ): void => {
      const existing = internalRef.current.get(sessionId);
      if (!existing) return;
      const now = Date.now();
      internalRef.current.set(sessionId, {
        ...existing,
        phase: outcome,
        lastEventAt: now,
        expiresAt: now + GC_AFTER_MS,
        ...(error !== undefined ? { error } : {}),
      });
      evictIfOverCapacity();
      publishSnapshot();
    },
    [evictIfOverCapacity, publishSnapshot],
  );

  const abort = useCallback(
    (sessionId: string): void => {
      const existing = internalRef.current.get(sessionId);
      if (!existing) return;
      if (isTerminal(existing.phase)) return;
      try {
        existing.controller.abort();
      } catch {
        /* already aborted — ignore */
      }
      const now = Date.now();
      internalRef.current.set(sessionId, {
        ...existing,
        phase: 'aborted',
        lastEventAt: now,
        expiresAt: now + GC_AFTER_MS,
      });
      // Drop any pending request for this session — runner shouldn't pick it up.
      pendingRef.current = pendingRef.current.filter(
        (r) => r.sessionId !== sessionId,
      );
      publishSnapshot();
      bumpQueue();
    },
    [bumpQueue, publishSnapshot],
  );

  const get = useCallback(
    (sessionId: string): StreamRecord | undefined => records.get(sessionId),
    [records],
  );

  const isActive = useCallback(
    (sessionId: string): boolean => {
      const r = records.get(sessionId);
      return r !== undefined && !isTerminal(r.phase);
    },
    [records],
  );

  // Periodic GC of expired terminated records.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      let dirty = false;
      for (const [id, rec] of internalRef.current.entries()) {
        if (rec.expiresAt !== undefined && rec.expiresAt < now) {
          internalRef.current.delete(id);
          dirty = true;
        }
      }
      if (dirty) publishSnapshot();
    }, GC_SWEEP_MS);
    return () => {
      clearInterval(interval);
    };
  }, [publishSnapshot]);

  const value = useMemo<StreamStoreContextValue>(
    () => ({
      records,
      queueVersion,
      startTurn,
      claimRequest,
      patch,
      finish,
      abort,
      get,
      isActive,
    }),
    [
      records,
      queueVersion,
      startTurn,
      claimRequest,
      patch,
      finish,
      abort,
      get,
      isActive,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStreamStore(): StreamStoreContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error('useStreamStore: missing <StreamStoreProvider>');
  }
  return v;
}

/** Subscribe to a single session's record. */
export function useStreamRecord(sessionId: string | undefined): StreamRecord | undefined {
  const { records } = useStreamStore();
  if (!sessionId) return undefined;
  return records.get(sessionId);
}

/** True while the session has an in-flight (non-terminal) stream. */
export function isStreamActive(record: StreamRecord | undefined): boolean {
  if (!record) return false;
  return !isTerminal(record.phase);
}
