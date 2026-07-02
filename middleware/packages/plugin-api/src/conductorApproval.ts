/**
 * Conductor human-await approval contract — the shared, channel-agnostic
 * surface a channel plugin needs to render a rich approval notification and
 * resolve the await it represents.
 *
 * The Conductor core enriches a reminder with a structured {@link ApprovalReminder}
 * (WHAT is being approved + the workflow's current step/progress); it does NOT
 * build any channel-specific card JSON. A channel that can render rich UI
 * (Teams Adaptive Card) consumes the payload and resolves the click in-process
 * via {@link ConductorAwaitResolver} — no HTTP round-trip. Channels without card
 * support ignore the payload and fall back to the reminder's plain text.
 *
 * Defined here (in the plugin-api contract, the single shared layer) so both the
 * Conductor core and the channel plugins import the same type.
 */

/** Structured approval context attached to a Conductor reminder. Best-effort —
 *  the index fields are omitted when the engine can't derive a stable position. */
export interface ApprovalReminder {
  /** the pending await this reminder is for — round-tripped on the resolve click. */
  awaitId: string;
  /** the run the await belongs to (audit / correlation). */
  runId: string;
  /** the human step message — WHAT is being approved. */
  question: string;
  /** human-readable workflow name (falls back to the slug upstream). */
  workflowName: string;
  /** current step id / label. */
  stepLabel: string;
  /** 1-based position of the step among the graph's steps (best-effort). */
  stepIndex?: number;
  /** total step count (best-effort). */
  totalSteps?: number;
  /** 'any' resumes on the first response; 'all' requires every holder. */
  quorum: 'any' | 'all';
}

/**
 * Kernel-published service a channel plugin late-resolves to resolve a Conductor
 * human await when a user clicks an approve/reject button. In-process — the
 * kernel wires it straight to the run executor's `resolveAwait`. `approved`
 * maps to the engine's fail-open response shape (`{ approved }`).
 */
export const CONDUCTOR_AWAIT_RESOLVER_SERVICE_NAME = 'conductorAwaitResolver';

/**
 * Outcome of an approve/reject click, so the channel can word an honest ack:
 * - `resumed`          the response completed the await and the run advanced.
 * - `recorded`         the vote was recorded but the await still waits on other holders (quorum 'all').
 * - `already_resolved` the await was no longer pending (stale card / double-click / a peer beat you).
 * - `not_a_holder`     the responder is not a current holder of this await — nothing recorded.
 */
export type ConductorAwaitOutcome = 'resumed' | 'recorded' | 'already_resolved' | 'not_a_holder';

export interface ConductorAwaitResolver {
  /** Resolve `awaitId` on behalf of `responderId` (the operator-addressable id —
   *  the user's email — matching the await holder / role key). Never throws for the
   *  expected not-pending / not-a-holder cases; returns the outcome instead. */
  resolve(awaitId: string, responderId: string, approved: boolean): Promise<ConductorAwaitOutcome>;
}
