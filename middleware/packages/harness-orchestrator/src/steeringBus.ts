/**
 * Mid-turn steering bus — a process-local registry that lets an out-of-band
 * HTTP request (`POST /chat/steer`) inject an extra user message into a chat
 * turn that is *already running* its server-side iteration loop.
 *
 * Lifecycle:
 *   1. `Orchestrator.chatStream` calls {@link SteeringBus.beginTurn} when a turn
 *      starts and {@link SteeringBus.endTurn} from its `finally` block.
 *   2. The `/chat/steer` route calls {@link SteeringBus.enqueue}. When a turn is
 *      live the message is buffered; otherwise the caller is told no turn is
 *      live (HTTP 409) so it can fall back to sending a normal new turn.
 *   3. At the top of every iteration the loop calls {@link SteeringBus.drain}
 *      and folds any buffered messages into the conversation before the next
 *      model call.
 *
 * Single-process by design: the orchestrator loop and the HTTP route share one
 * Node process, so a module-level singleton is sufficient. A multi-instance
 * deployment with sticky sessions (a session pinned to one instance) stays
 * correct; a fan-out deployment would need a shared bus (Redis / Postgres
 * LISTEN-NOTIFY) — out of scope for this slice.
 *
 * The bus deliberately holds no message history and no PII beyond the transient
 * in-flight buffer, which is cleared on `endTurn` and on each `drain`.
 */

/**
 * Max buffered steer messages per live turn. A hammering client can't grow the
 * buffer without bound — the oldest entries are dropped beyond this cap.
 */
const MAX_QUEUED_PER_TURN = 8;

/** Max accepted length (chars) of a single steer message. */
export const MAX_STEER_LENGTH = 4000;

export interface SteerEnqueueResult {
  /** True when a turn was live and the message was buffered. */
  live: boolean;
  /** Number of messages now buffered for this turn (0 when not live). */
  queued: number;
}

export class SteeringBus {
  private readonly live = new Set<string>();
  private readonly queues = new Map<string, string[]>();

  /** Mark a turn live under `key` (the session scope). Clears any stale queue
   *  left under the same key by a previous turn so it can't leak forward. */
  beginTurn(key: string): void {
    this.live.add(key);
    this.queues.delete(key);
  }

  /** Mark the turn finished and drop its buffer. Idempotent. */
  endTurn(key: string): void {
    this.live.delete(key);
    this.queues.delete(key);
  }

  isLive(key: string): boolean {
    return this.live.has(key);
  }

  /**
   * Buffer a steer message for the live turn under `key`. Returns whether a
   * turn was live (so the caller can 409 + fall back) and the resulting queue
   * depth. No-op for an empty message or when no turn is live.
   */
  enqueue(key: string, text: string): SteerEnqueueResult {
    const trimmed = text.trim();
    const live = this.live.has(key);
    if (!live || trimmed.length === 0) {
      return { live, queued: 0 };
    }
    const queue = this.queues.get(key) ?? [];
    queue.push(trimmed.slice(0, MAX_STEER_LENGTH));
    while (queue.length > MAX_QUEUED_PER_TURN) queue.shift();
    this.queues.set(key, queue);
    return { live: true, queued: queue.length };
  }

  /** Return and clear all buffered messages for the turn (FIFO order). */
  drain(key: string): string[] {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return [];
    this.queues.set(key, []);
    return queue;
  }
}

/** Process-wide singleton shared by the orchestrator loop and the chat route. */
export const steeringBus = new SteeringBus();
