/**
 * #2082 — agent-owned triggers (spec 2042 §5.12, ADR-0020): the domain types.
 *
 * A trigger lets an agent act unasked: a hook on an event, a one-shot wakeup
 * or a short-lived timer. Each one names its purpose, the context it belongs
 * to, a deadline, limits and a budget, and a chain of actions the harness runs
 * cheapest first (`check`, `post`, `deliver` without a model; `turn` only
 * where judgement or language is needed).
 */

export const TRIGGER_KINDS = ['on_event', 'wake_at', 'wake_every'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Who asked for the trigger. A routine keeps its human owner. */
export type TriggerOrigin = 'agent' | 'routine' | 'system';

export const CONTEXT_KINDS = ['conversation', 'meeting', 'facilitation', 'task', 'routine', 'memory'] as const;
export type TriggerContextKind = (typeof CONTEXT_KINDS)[number];

/**
 * Droppable effects (reminders, nudges) are never retried after an unknown
 * outcome; essential ones are retried until confirmed, accepting a rare
 * duplicate (channels give no exactly-once delivery).
 */
export type DeliveryClass = 'droppable' | 'essential';

export type TriggerState = 'active' | 'paused';

/** A read action the harness runs under the agent's grants: no model. */
export interface DataActionSpec {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export type CheckKind = 'new_activity' | 'context_live' | 'data';

export type TriggerStep =
  | { readonly type: 'check'; readonly check: 'new_activity' }
  | { readonly type: 'check'; readonly check: 'context_live' }
  | {
      readonly type: 'check';
      readonly check: 'data';
      readonly action: DataActionSpec;
      /** `rows`: go on when the action returns at least one row.
       *  `changed`: go on when the result differs from the last firing's. */
      readonly condition: 'rows' | 'changed';
    }
  | { readonly type: 'post'; readonly template: string }
  | { readonly type: 'deliver'; readonly action: DataActionSpec; readonly title?: string }
  | { readonly type: 'turn'; readonly instruction: string };

export type TriggerStepType = TriggerStep['type'];

/** A person or conversation a proactive message may go to besides the origin. */
export type TriggerTarget =
  | { readonly kind: 'conversation'; readonly channel: string; readonly ref: unknown }
  | { readonly kind: 'person'; readonly channel: string; readonly principalId: string; readonly ref: unknown };

/** Where the trigger was created: the default delivery target and its labels. */
export interface TriggerOriginContext {
  readonly channel: string;
  readonly conversationRef: unknown;
  /** Discretion labels of the creating context (INV-9). */
  readonly labels: readonly string[];
}

export interface Trigger {
  readonly id: string;
  readonly agentId: string;
  readonly agentSlug: string;
  readonly kind: TriggerKind;
  readonly origin: TriggerOrigin;
  readonly ownerKey: string | null;
  readonly purpose: string;
  readonly contextKind: TriggerContextKind;
  readonly contextId: string;
  readonly deliveryChannel: string | null;
  readonly deliveryRef: unknown;
  readonly target: TriggerTarget | null;
  readonly labels: readonly string[];
  readonly eventId: string | null;
  readonly eventFilter: unknown;
  readonly fireAt: Date | null;
  readonly intervalSeconds: number | null;
  readonly cron: string | null;
  readonly timezone: string | null;
  readonly liveContext: boolean;
  readonly actions: readonly TriggerStep[];
  readonly deliveryClass: DeliveryClass;
  readonly until: Date;
  readonly maxRuns: number | null;
  readonly runs: number;
  readonly state: TriggerState;
  readonly pauseReason: string | null;
  readonly consecutiveFailures: number;
  readonly consecutiveIneffective: number;
  readonly budgetPerFiringUsd: number;
  readonly budgetTotalUsd: number;
  readonly modelCallsPerFiring: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly lastFiredAt: Date | null;
  readonly lastOutcome: string | null;
  readonly lastError: string | null;
  readonly lastFingerprint: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** A validated request, ready to store. */
export interface NewTrigger {
  readonly agentId: string;
  readonly agentSlug: string;
  readonly kind: TriggerKind;
  readonly origin: TriggerOrigin;
  readonly ownerKey: string | null;
  readonly purpose: string;
  readonly contextKind: TriggerContextKind;
  readonly contextId: string;
  readonly deliveryChannel: string | null;
  readonly deliveryRef: unknown;
  readonly target: TriggerTarget | null;
  readonly labels: readonly string[];
  readonly eventId: string | null;
  readonly eventFilter: unknown;
  readonly fireAt: Date | null;
  readonly intervalSeconds: number | null;
  readonly cron: string | null;
  readonly timezone: string | null;
  readonly liveContext: boolean;
  readonly actions: readonly TriggerStep[];
  readonly deliveryClass: DeliveryClass;
  readonly until: Date;
  readonly maxRuns: number | null;
  readonly budgetPerFiringUsd: number;
  readonly budgetTotalUsd: number;
  readonly modelCallsPerFiring: number;
  readonly createdBy: string;
}

export type OccurrenceState = 'pending' | 'leased' | 'done' | 'dropped';

export interface Occurrence {
  readonly id: string;
  readonly triggerId: string;
  readonly occurrenceKey: string;
  readonly dueAt: Date;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly attempts: number;
}

/** Why a trigger ended. The row is deleted; the audit keeps the reason. */
export type TriggerEndReason =
  | 'expired'
  | 'max_runs'
  | 'context_ended'
  | 'cancelled'
  | 'agent_gone'
  | 'fired';

/** Why a trigger was paused; an operator (or the owner) resumes it. */
export type TriggerPauseReason = 'breaker_failures' | 'breaker_ineffective' | 'budget' | 'owner' | 'operator';

export type TriggerRefusalCode =
  | 'invalid'
  | 'deadline_missing'
  | 'deadline_too_far'
  | 'max_runs_missing'
  | 'interval_too_short'
  | 'too_many_active'
  | 'budget_too_high'
  | 'unknown_event'
  | 'unknown_tool'
  | 'target_not_allowed'
  | 'no_context';

export interface TriggerRefusal {
  readonly ok: false;
  readonly code: TriggerRefusalCode;
  readonly message: string;
}
