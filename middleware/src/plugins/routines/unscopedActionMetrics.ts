/**
 * #1025 / #1029 — counters for routine card actions that ran UNSCOPED.
 *
 * WHY A FOURTH MODULE OF THIS SHAPE
 * ---------------------------------
 * `brokerMetrics` (#578), `securityScreenMetrics` (#749) and
 * `foreignToolMetrics` (#1008) are three parallel modules with the same
 * shape and no shared factory. Neither of the existing two fits
 * semantically — one counts credential-broker denials, the other counts
 * foreign CLI tool calls — and widening either to carry routine actions
 * would make its name lie. So this follows the established shape rather
 * than inventing a pattern, which is the part worth reusing.
 *
 * WHAT IT COUNTS
 * --------------
 * A smart-card click that reached pause/resume/trigger/delete with no
 * principal to scope it: no `actor` from the channel and no captured turn
 * context. Those calls act cross-tenant, exactly as they did before
 * #1025.
 *
 * The expected value is NOT zero, unlike `foreignToolMetrics`. Today the
 * Teams adapter dispatches card clicks out-of-band and passes no `actor`,
 * so every click lands here. That is the point: refusing would break all
 * four buttons in production, and scoping to nobody would be worse than a
 * hole you can see. The counter is what makes it visible, and what tells
 * an operator the adapter-side fix has actually shipped — the count stops
 * rising and the fallback can be deleted.
 *
 * Process-scoped and in-memory, same trade as the three modules above:
 * this answers "is anything still acting unscoped RIGHT NOW", which has to
 * survive a deployment with no Postgres and no telemetry pool.
 */

export type UnscopedRoutineAction =
  | 'pause'
  | 'resume'
  | 'trigger_now'
  | 'delete';

export interface UnscopedRoutineActionMetrics {
  /** Unscoped card actions since process start. */
  readonly calls: number;
  /** Per-action counts, so an operator can see WHICH button is unscoped. */
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
  action: UnscopedRoutineAction,
  routineId: string,
  calls: number,
): void {
  console.error(
    `[security] UNSCOPED routine card action "${action}" on routine ` +
      `"${routineId}" — no actor was supplied and no turn context was ` +
      'captured, so this ran cross-tenant (#1025). The channel adapter ' +
      'should pass `actor` on handleRoutineAction. ' +
      `unscopedRoutineActionsThisProcess=${String(calls)}`,
  );
}

/**
 * Count one unscoped card action and announce it. Never throws: this is
 * evidence, and evidence must not be able to break the action it is
 * evidence about — the same contract `recordForeignToolCall` keeps.
 */
export function recordUnscopedRoutineAction(
  action: UnscopedRoutineAction,
  routineId: string,
  onAlert: (
    action: UnscopedRoutineAction,
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
export function getUnscopedRoutineActionMetrics(): UnscopedRoutineActionMetrics {
  return {
    calls: state.calls,
    byAction: { ...state.byAction },
    firstSeenAt: state.firstSeenAt,
    lastSeenAt: state.lastSeenAt,
  };
}

/** Test-only reset. Module state would otherwise leak between test files. */
export function resetUnscopedRoutineActionMetrics(): void {
  state = emptyState();
}
