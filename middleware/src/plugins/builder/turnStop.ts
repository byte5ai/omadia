import type { BuilderEvent } from './builderAgent.js';
import { draftTurnStopReason } from './draftTurnLock.js';

/**
 * #2214 — helpers for ending a stopped builder turn cleanly.
 *
 * A stop must not free the draft while one of the turn's tool calls is still
 * writing to it: a `fill_slot` mid-typecheck would otherwise land in the
 * draft after the next turn has started (the last-writer-wins bug of #1804).
 * The turn therefore tracks its running tool calls and waits for them,
 * bounded, before it reports itself stopped.
 */

/** How long a stopped turn waits for its running tool calls. */
export const STOP_TOOL_DRAIN_MS = 20_000;

export class InFlightToolCalls {
  private readonly pending = new Set<Promise<unknown>>();

  /** Register a running tool call; returns the same promise. */
  track<T>(call: Promise<T>): Promise<T> {
    this.pending.add(call);
    call
      .finally(() => {
        this.pending.delete(call);
      })
      .catch(() => {
        // The caller handles the call's own rejection; this branch only
        // keeps the bookkeeping promise from rejecting unhandled.
      });
    return call;
  }

  /** `true` once every tracked call has settled, `false` after `timeoutMs`. */
  async settle(timeoutMs: number): Promise<boolean> {
    if (this.pending.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([
        Promise.allSettled([...this.pending]).then(() => true),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The terminal frame of a stopped (or timed-out) turn. */
export function stoppedTurnEvent(signal: AbortSignal): BuilderEvent {
  const reason = draftTurnStopReason(signal);
  return reason === 'timeout'
    ? {
        type: 'error',
        code: 'builder.turn_timeout',
        message: 'builder turn exceeded its time budget and was stopped',
      }
    : { type: 'error', code: 'builder.turn_stopped', message: 'builder turn was stopped' };
}

/**
 * Events still worth delivering after a stop: everything that reports a
 * change or a result. Liveness pulses and token chunks are stale by then.
 */
export function isDeliverableAfterStop(ev: BuilderEvent): boolean {
  return ev.type !== 'heartbeat' && ev.type !== 'stream_token_chunk';
}
