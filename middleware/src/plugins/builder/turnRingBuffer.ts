import { EventEmitter } from 'node:events';

import type { BuilderEvent } from './builderAgent.js';

/**
 * Per-turn replay buffer for the BuilderAgent's NDJSON stream.
 *
 * Each turn (`POST /drafts/:id/turn`) is recorded under its server-assigned
 * turnId so a client whose connection drops mid-stream can re-attach via
 * `GET /drafts/:id/turn/:turnId/resume?since=<lastEventId>` and pick up
 * exactly where it left off — without a duplicate LLM call. New events
 * arriving after a resume subscription are forwarded live; the resume
 * stream closes when the turn finalises.
 *
 * Memory bounds:
 *   - At most `maxEventsPerTurn` frames per turn (default 1024). The agent
 *     today emits well under 100 events per turn (chat_message + a handful
 *     of tool_use/tool_result + maybe a few patches), so the cap is purely
 *     defensive against runaway loops.
 *   - Finalised turns are GC'd after `gcAfterMs` (default 10 min) — long
 *     enough for a tab to come back from sleep, short enough to keep the
 *     Map from drifting.
 *
 * Threading: the kernel is single-threaded JS. No locking needed. The
 * EventEmitter dispatch is synchronous, so a `record` call returns after
 * every active `subscribe`-handler has seen the frame.
 */

export interface StampedFrame {
  /** 1-based monotonic id within the turn. Strictly increasing. */
  readonly id: number;
  readonly ev: BuilderEvent;
}

export interface BuilderTurnRingBufferOptions {
  /** Max frames retained per turn. Defaults to 1024. */
  readonly maxEventsPerTurn?: number;
  /** Delay before a finalised turn is removed from the buffer. */
  readonly gcAfterMs?: number;
  /** Test seam — the buffer schedules GC via this hook. */
  readonly setTimer?: (
    fn: () => void,
    delayMs: number,
  ) => { unref(): void } | NodeJS.Timeout;
  /** Test seam — pair with `setTimer` to cancel the GC timer. */
  readonly clearTimer?: (timer: ReturnType<NonNullable<BuilderTurnRingBufferOptions['setTimer']>>) => void;
}

interface TurnRecord {
  readonly turnId: string;
  readonly events: StampedFrame[];
  nextId: number;
  final: boolean;
  finalizedAt: number | null;
  gcTimer: ReturnType<NonNullable<BuilderTurnRingBufferOptions['setTimer']>> | null;
  readonly emitter: EventEmitter;
}

const DEFAULT_MAX_EVENTS = 1024;
const DEFAULT_GC_MS = 10 * 60 * 1000;

const FRAME_EVENT = 'frame';
const FINAL_EVENT = 'final';

export class BuilderTurnRingBuffer {
  private readonly turns = new Map<string, TurnRecord>();
  private readonly maxEventsPerTurn: number;
  private readonly gcAfterMs: number;
  private readonly setTimer: NonNullable<BuilderTurnRingBufferOptions['setTimer']>;
  private readonly clearTimer: NonNullable<BuilderTurnRingBufferOptions['clearTimer']>;

  constructor(opts: BuilderTurnRingBufferOptions = {}) {
    this.maxEventsPerTurn = opts.maxEventsPerTurn ?? DEFAULT_MAX_EVENTS;
    this.gcAfterMs = opts.gcAfterMs ?? DEFAULT_GC_MS;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        if (typeof t.unref === 'function') t.unref();
        return t;
      });
    this.clearTimer =
      opts.clearTimer ??
      ((t) => {
        clearTimeout(t as NodeJS.Timeout);
      });
  }

  /** Begin recording a new turn. No-op if the turnId is already known. */
  start(turnId: string): void {
    if (this.turns.has(turnId)) return;
    const emitter = new EventEmitter();
    // A long-running turn can plausibly fan out to several reconnecting
    // tabs, so lift the default ceiling to avoid spurious leak warnings.
    emitter.setMaxListeners(64);
    this.turns.set(turnId, {
      turnId,
      events: [],
      nextId: 1,
      final: false,
      finalizedAt: null,
      gcTimer: null,
      emitter,
    });
  }

  /** Append an event to the turn buffer. Throws if the turn was never
   *  started or has already finalised. */
  record(turnId: string, ev: BuilderEvent): StampedFrame {
    const rec = this.turns.get(turnId);
    if (!rec) {
      throw new Error(`turnRingBuffer.record: unknown turn '${turnId}'`);
    }
    if (rec.final) {
      throw new Error(
        `turnRingBuffer.record: turn '${turnId}' already finalised`,
      );
    }
    const frame: StampedFrame = { id: rec.nextId, ev };
    rec.nextId += 1;
    rec.events.push(frame);
    while (rec.events.length > this.maxEventsPerTurn) {
      rec.events.shift();
    }
    rec.emitter.emit(FRAME_EVENT, frame);
    return frame;
  }

  /** Mark a turn as finalised. Subsequent `record` calls throw. The buffer
   *  is GC'd after `gcAfterMs`. */
  finalize(turnId: string): void {
    const rec = this.turns.get(turnId);
    if (!rec || rec.final) return;
    rec.final = true;
    rec.finalizedAt = Date.now();
    rec.emitter.emit(FINAL_EVENT);
    rec.gcTimer = this.setTimer(() => {
      // Drop only if still finalised (defensive — a re-`start` with the
      // same id should not be GC'd by an old timer; we make `start` a
      // no-op against existing ids, so this branch is theoretical).
      const current = this.turns.get(turnId);
      if (current && current.final) {
        this.turns.delete(turnId);
      }
    }, this.gcAfterMs);
  }

  /** Returns frames whose `id > since`. Returns `null` if the turn is
   *  unknown (already GC'd or never started). */
  snapshot(turnId: string, since = 0): StampedFrame[] | null {
    const rec = this.turns.get(turnId);
    if (!rec) return null;
    if (since <= 0) return rec.events.slice();
    return rec.events.filter((f) => f.id > since);
  }

  /** `null` if unknown. */
  isFinal(turnId: string): boolean | null {
    const rec = this.turns.get(turnId);
    if (!rec) return null;
    return rec.final;
  }

  /**
   * Subscribe for frames after `since` (inclusive of any newly-arriving
   * frames; replay of buffered ones is the caller's job via `snapshot`).
   *
   * If the turn is already finalised, `onFinal` is invoked synchronously
   * and the returned unsubscribe is a no-op.
   *
   * If the turn is unknown, `onFinal` is invoked synchronously (treating
   * 'unknown' as 'already gone').
   */
  subscribe(
    turnId: string,
    onFrame: (frame: StampedFrame) => void,
    onFinal: () => void,
  ): () => void {
    const rec = this.turns.get(turnId);
    if (!rec) {
      onFinal();
      return () => {};
    }
    if (rec.final) {
      onFinal();
      return () => {};
    }
    const frameHandler = (frame: StampedFrame): void => onFrame(frame);
    const finalHandler = (): void => onFinal();
    rec.emitter.on(FRAME_EVENT, frameHandler);
    rec.emitter.once(FINAL_EVENT, finalHandler);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      rec.emitter.off(FRAME_EVENT, frameHandler);
      rec.emitter.off(FINAL_EVENT, finalHandler);
    };
  }

  /** Test-only helpers. */
  activeTurnCount(): number {
    return this.turns.size;
  }
  hasTurn(turnId: string): boolean {
    return this.turns.has(turnId);
  }
  /** Manually drop a turn's buffer regardless of finalisation state. */
  forget(turnId: string): void {
    const rec = this.turns.get(turnId);
    if (!rec) return;
    if (rec.gcTimer) this.clearTimer(rec.gcTimer);
    this.turns.delete(turnId);
  }
}
