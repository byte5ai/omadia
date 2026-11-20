/**
 * #2082 — when a timer's next occurrence is due. Pure.
 *
 * A one-shot wakeup has exactly one occurrence. A recurring timer runs on a
 * fixed interval anchored at its last due time (never drifting with how long a
 * firing took), or on a cron pattern in its time zone (routines keep their
 * calendar semantics). Nothing is due after the deadline.
 */

import { createCron } from '../scheduler/cronerCompat.js';

export interface TimerShape {
  readonly kind: 'on_event' | 'wake_at' | 'wake_every';
  readonly fireAt: Date | null;
  readonly intervalSeconds: number | null;
  readonly cron: string | null;
  readonly timezone: string | null;
  readonly until: Date;
}

/** Stable key of a timer occurrence: its due time. */
export const timerOccurrenceKey = (dueAt: Date): string => `at:${dueAt.toISOString()}`;

/** Stable key of a hook occurrence: the event and its id. */
export const eventOccurrenceKey = (eventId: string, eventKey: string): string => `event:${eventId}:${eventKey}`;

/**
 * The first occurrence of a new timer. An interval timer first fires one
 * interval after creation; a cron timer at its next match.
 */
export function firstDue(t: TimerShape, now: Date): Date | undefined {
  if (t.kind === 'wake_at') return t.fireAt && t.fireAt <= t.until ? t.fireAt : undefined;
  if (t.kind !== 'wake_every') return undefined;
  return nextAfter(t, now);
}

/** The occurrence after `previousDue`, or undefined past the deadline. */
export function nextDue(t: TimerShape, previousDue: Date, now: Date): Date | undefined {
  if (t.kind !== 'wake_every') return undefined;
  if (t.intervalSeconds !== null) {
    // Anchored at the previous due time; a long outage skips the missed slots
    // instead of firing them back to back.
    const step = t.intervalSeconds * 1000;
    let next = previousDue.getTime() + step;
    if (next <= now.getTime()) {
      const missed = Math.floor((now.getTime() - next) / step) + 1;
      next += missed * step;
    }
    const due = new Date(next);
    return due <= t.until ? due : undefined;
  }
  const from = previousDue > now ? previousDue : now;
  return nextAfter(t, from);
}

function nextAfter(t: TimerShape, from: Date): Date | undefined {
  let due: Date | null | undefined;
  if (t.intervalSeconds !== null) {
    due = new Date(from.getTime() + t.intervalSeconds * 1000);
  } else if (t.cron) {
    due = createCron(t.cron, t.timezone ? { timezone: t.timezone } : {}).nextRun(from);
  }
  return due && due <= t.until ? due : undefined;
}

/**
 * How many times a recurring timer fires after `from` up to `until` (at most
 * `cap`). Used when a deadline moves: the run cap grows with the period.
 */
export function runsUntil(t: TimerShape, from: Date, until: Date, cap: number): number {
  if (t.kind !== 'wake_every') return 0;
  const shape: TimerShape = { ...t, until };
  let count = 0;
  let due = nextAfter(shape, from);
  while (due && count < cap) {
    count += 1;
    due = nextAfter(shape, due);
  }
  return count;
}
