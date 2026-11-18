/**
 * #1025 / #1029 — counters for routine card actions that were REFUSED because
 * the channel named no principal.
 *
 * WHY A FOURTH MODULE OF THIS SHAPE
 * ---------------------------------
 * `brokerMetrics` (#578), `securityScreenMetrics` (#749) and
 * `foreignToolMetrics` (#1008) are three parallel modules with the same
 * shape and no shared factory. None of them fits semantically, and widening
 * one to carry routine actions would make its name lie. So this follows the
 * established shape rather than inventing a pattern, which is the part worth
 * reusing.
 *
 * WHAT IT COUNTS
 * --------------
 * A smart-card click that reached `handleRoutineAction` without a usable
 * `actor` — none at all, a blank tenant or user id, or not a pair of strings.
 * Such a click is refused with `RoutineActorRequiredError` before any routine
 * is read or changed (`routineCardActor.ts`). Until then this module counted
 * the same clicks as UNSCOPED runs, because #1029 let them proceed
 * cross-tenant; that fallback is gone, and with it the reason the count was
 * expected to be non-zero.
 *
 * The expected value on a current deployment is ZERO: channel-teams passes
 * `actor` since 0.26.1. A count that rises means an adapter in the field
 * still sends identity-less clicks — an older channel-teams, or another
 * channel plugin that does not pass `actor` — and its users get the refusal
 * on every routine button until that plugin is updated. The count is how an
 * operator sees that before the users report it.
 *
 * Process-scoped and in-memory, same trade as the three modules above:
 * this answers "is anything being refused RIGHT NOW", which has to survive a
 * deployment with no Postgres and no telemetry pool.
 */

import type { RoutineCardAction } from './routineSmartCard.js';

export interface RefusedRoutineActionMetrics {
  /** Refused card actions since process start. */
  readonly calls: number;
  /** Per-action counts, so an operator can see WHICH button is refused. */
  readonly byAction: Readonly<Record<string, number>>;
  /** Epoch ms of the first occurrence, or undefined while the count is 0. */
  readonly firstSeenAt: number | undefined;
  /** Epoch ms of the most recent occurrence, or undefined while 0. */
  readonly lastSeenAt: number | undefined;
}

interface MutableState {
  calls: number;
  byAction: Record<string, number>;
  firstSeenAt: number | undefined;
  lastSeenAt: number | undefined;
}

function emptyState(): MutableState {
  return {
    calls: 0,
    byAction: {},
    firstSeenAt: undefined,
    lastSeenAt: undefined,
  };
}

let state: MutableState = emptyState();

function defaultAlert(
  action: RoutineCardAction,
  routineId: string,
  calls: number,
): void {
  console.error(
    `[security] REFUSED routine card action "${action}" on routine ` +
      `"${routineId}" — the channel adapter supplied no usable actor ` +
      '(tenant and userId are both required on handleRoutineAction; ' +
      'channel-teams sends them from 0.26.1). ' +
      `refusedRoutineActionsThisProcess=${String(calls)}`,
  );
}

/**
 * Count one refused card action and announce it. Never throws: this is
 * evidence, and evidence must not be able to change the outcome it is
 * evidence about — the same contract `recordForeignToolCall` keeps.
 */
export function recordRefusedRoutineAction(
  action: RoutineCardAction,
  routineId: string,
  onAlert: (
    action: RoutineCardAction,
    routineId: string,
    calls: number,
  ) => void = defaultAlert,
): void {
  try {
    const now = Date.now();
    state.calls += 1;
    state.byAction[action] = (state.byAction[action] ?? 0) + 1;
    state.firstSeenAt ??= now;
    state.lastSeenAt = now;
    onAlert(action, routineId, state.calls);
  } catch {
    /* counters are best-effort */
  }
}

/** An immutable snapshot. Callers cannot mutate the counters through it. */
export function getRefusedRoutineActionMetrics(): RefusedRoutineActionMetrics {
  return {
    calls: state.calls,
    byAction: { ...state.byAction },
    firstSeenAt: state.firstSeenAt,
    lastSeenAt: state.lastSeenAt,
  };
}

/** Test-only reset. Module state would otherwise leak between test files. */
export function resetRefusedRoutineActionMetrics(): void {
  state = emptyState();
}
