import type { RunStatus } from './runStore.js';

/**
 * #1705 — the vocabulary of outbound run-lifecycle webhook events, in ONE place.
 *
 * Before this, the event name was derived inline in `index.ts`'s `notifyRunEnded`
 * hook as `run.status === 'completed' ? 'run.completed' : 'run.failed'`, i.e. every
 * non-completed terminal status collapsed into `run.failed`. An operator cancel
 * (#759 made `cancelled` a terminal status of its own) was therefore delivered as
 * `x-omadia-event: run.failed` carrying `payload.status: "cancelled"`, so a receiver
 * that treats a crash differently from a cancel had to ignore the event name it
 * subscribed to and parse the payload instead. Meanwhile a subscription on
 * `run.cancelled` was accepted (the column is free text, nothing validated it) and
 * then never fired.
 *
 * So: a terminal status maps 1:1 to an event name here, and `isConductorWebhookEvent`
 * is the guard `webhookRoutes.ts` uses to refuse a subscription to an event that
 * would never fire. The DB column stays free text (migration 0007) — the constraint
 * lives at the API edge, so a row written by an older build keeps working and a
 * future emit id only has to be added to this list.
 */

export const CONDUCTOR_WEBHOOK_EVENTS = ['run.completed', 'run.failed', 'run.cancelled'] as const;

export type ConductorWebhookEvent = (typeof CONDUCTOR_WEBHOOK_EVENTS)[number];

/** The terminal run statuses that have an event, each with the name it fires under. */
const EVENT_BY_TERMINAL_STATUS = {
  completed: 'run.completed',
  failed: 'run.failed',
  cancelled: 'run.cancelled',
} as const satisfies Partial<Record<RunStatus, ConductorWebhookEvent>>;

/** The run statuses `runEndedEvent` answers for — a terminal, deliverable outcome.
 *  Derived from the map above rather than listed again, so a status can never be
 *  added to the mapping and forgotten in the guard below. */
export type ConductorRunEndedStatus = keyof typeof EVENT_BY_TERMINAL_STATUS;

/** Is this one of the events the dispatcher can ever fire? */
export function isConductorWebhookEvent(value: string): value is ConductorWebhookEvent {
  return (CONDUCTOR_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * The event name for a run that just ended — `null` for a status that is not
 * terminal ('running' / 'waiting'). A null answer means "nothing to deliver": the
 * caller must NOT fall back to a name, which is exactly the bug #1705 reports.
 */
export function runEndedEvent(status: RunStatus): ConductorWebhookEvent | null {
  return isRunEndedStatus(status) ? EVENT_BY_TERMINAL_STATUS[status] : null;
}

function isRunEndedStatus(status: RunStatus): status is ConductorRunEndedStatus {
  return Object.prototype.hasOwnProperty.call(EVENT_BY_TERMINAL_STATUS, status);
}
