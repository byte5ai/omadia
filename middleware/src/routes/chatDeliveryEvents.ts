import type { Request, Response } from 'express';

import {
  readStreamSession,
  watchStreamSession,
  type StreamSessionDeps,
} from './builderEventsSession.js';

/**
 * #2354 (ADR-0321) — live routine deliveries for an open web chat.
 *
 * A routine delivers into a web chat by appending to the chat document on the
 * server (`webChatProactiveSender`). The web UI re-read the chat on mount,
 * focus, visibility and a 60 s poll, so a delivery into the chat the user was
 * looking at showed up late or only after a reload.
 *
 * `GET /api/chat/sessions/:id/events` is a server-sent-events stream of the
 * chat's deliveries. Each event is a SIGNAL only — `{ type: 'delivery',
 * sessionId, deliveredAt }`, never the text: the browser then re-reads the
 * chat through `GET /api/chat/sessions/:id`, the one read path that applies
 * the owner check and the stored shape. The stream opens only for the
 * caller's own chat (the router checks that first) and ends with the session
 * that opened it (`watchStreamSession`, as the builder's event stream).
 *
 * The bus is process-local: a delivery written by another middleware process
 * reaches the browser through its poll, as before.
 */

/** The one event a delivery stream carries. */
export interface ChatDeliveryEvent {
  readonly type: 'delivery';
  readonly sessionId: string;
  readonly deliveredAt: number;
}

type Listener = (event: ChatDeliveryEvent) => void;

/** In-process fan-out of deliveries to the open streams of a chat. */
export class ChatDeliveryBus {
  readonly #listeners = new Map<string, Set<Listener>>();

  /** Subscribe to one chat's deliveries; returns the unsubscribe. */
  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.#listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.#listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.#listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#listeners.delete(sessionId);
    };
  }

  /** Tell the open streams of a chat that a delivery landed. Never throws. */
  publish(event: ChatDeliveryEvent): void {
    const set = this.#listeners.get(event.sessionId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (err) {
        console.warn(
          `[chat-deliveries] listener failed for chat '${event.sessionId}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Open streams of a chat (tests, diagnostics). */
  listenerCount(sessionId: string): number {
    return this.#listeners.get(sessionId)?.size ?? 0;
  }
}

export interface ChatDeliveryStreamDeps {
  readonly bus: ChatDeliveryBus;
  /** Session lifetime of an open stream (same wiring as the builder's). */
  readonly sessions: StreamSessionDeps;
  /** Heartbeat and session-check cadence in ms. Default 25 000; 0 = none (tests). */
  readonly heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 25_000;

/**
 * Open the delivery stream of chat `sessionId` on `res`. The caller has
 * already checked that the chat is the caller's own. Answers 401 when the
 * request carries no session the stream could be bound to.
 */
export function openChatDeliveryStream(
  req: Request,
  res: Response,
  sessionId: string,
  deps: ChatDeliveryStreamDeps,
): void {
  const session = readStreamSession(req);
  if (!session) {
    res.status(401).json({ error: 'no_session' });
    return;
  }
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  res.write(': connected\n\n');

  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe();
    watch.dispose();
    if (!res.writableEnded) res.end();
  };
  const write = (chunk: string): boolean => {
    try {
      res.write(chunk);
      return true;
    } catch {
      close();
      return false;
    }
  };

  const watch = watchStreamSession(session, deps.sessions, (reason) => {
    console.log(`[chat-deliveries] stream ended (chat=${sessionId}, reason=${reason})`);
    close();
  });

  const unsubscribe = deps.bus.subscribe(sessionId, (event) => {
    if (closed || !watch.isCurrent()) return;
    write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (closed || !watch.isCurrent()) return;
      if (write(': ping\n\n')) watch.check();
    }, heartbeatMs);
    heartbeat.unref();
  }

  res.once('close', close);
  // A revocation between the request's own check and the listener above is
  // caught here instead of at the first heartbeat.
  watch.check();
}
