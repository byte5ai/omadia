/**
 * Epic #470 W0 — in-process fan-out for the job-event SSE tail (spec §9).
 *
 * The DB (`dev_job_events`) is the source of truth: every event is persisted
 * before it is published, and an SSE reader replays from `dev_job_events.id`
 * on (re)connect. This bus is ONLY the live tail — it lets an already-attached
 * `GET /jobs/:id/events` reader receive an event the instant `appendEvents`
 * commits it, instead of polling.
 *
 * Pattern mirrors `plugins/builder/specEventBus.ts`: one lazy `EventEmitter`
 * per jobId, dropped when its last listener leaves (no `Map` leak across a
 * long-lived process). There is deliberately NO buffering here — a late
 * subscriber catches up from the DB, not from an in-memory ring — so the bus
 * cannot grow unbounded. It holds no timers.
 */

import { EventEmitter } from 'node:events';

import type { DevJobEvent } from './types.js';

export type DevJobEventListener = (event: DevJobEvent) => void;

const EVENT_NAME = 'event';

/** Many concurrent readers per job are legitimate (admin tab + W3 chat card +
 *  reconnects); lift the default 10-listener cap without going to Infinity so a
 *  genuine leak still surfaces. */
const MAX_LISTENERS_PER_JOB = 64;

export class DevJobEventBus {
  private readonly emitters = new Map<string, EventEmitter>();

  /**
   * Subscribe to a job's live event tail. Returns an unsubscribe function; when
   * the last listener for a job leaves, the emitter is discarded.
   */
  subscribe(jobId: string, listener: DevJobEventListener): () => void {
    let emitter = this.emitters.get(jobId);
    if (!emitter) {
      emitter = new EventEmitter();
      emitter.setMaxListeners(MAX_LISTENERS_PER_JOB);
      this.emitters.set(jobId, emitter);
    }
    emitter.on(EVENT_NAME, listener);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const e = this.emitters.get(jobId);
      if (!e) return;
      e.off(EVENT_NAME, listener);
      if (e.listenerCount(EVENT_NAME) === 0) this.emitters.delete(jobId);
    };
  }

  /**
   * Publish a stored event to a job's subscribers. No-op when nobody is
   * listening — the event is already durable in `dev_job_events`, so a reader
   * that attaches later replays it from the DB.
   */
  publish(jobId: string, event: DevJobEvent): void {
    this.emitters.get(jobId)?.emit(EVENT_NAME, event);
  }

  /** Number of live subscribers for a job (0 if none). */
  listenerCount(jobId: string): number {
    return this.emitters.get(jobId)?.listenerCount(EVENT_NAME) ?? 0;
  }

  /** Number of jobs with at least one live subscriber. Test/introspection only. */
  activeJobCount(): number {
    return this.emitters.size;
  }
}
