/**
 * #749 — counters for the inbound security screener (#579).
 *
 * ## Why this exists
 *
 * `screenProvenance` is fail-open by design: a screener that raises yields
 * `unscreenable` and the turn proceeds. That policy is right — an unavailable
 * judge must not take the product down — but before this module the only trace
 * was one `console.warn` per event. At turn volume, a screener that is broken
 * for **every** request and one that blipped once produce the same shape of
 * output, differing only in a volume nobody watches.
 *
 * That is not hypothetical. Until #748, `LlmScreener` sent a `temperature` the
 * default model rejects, so every screen raised, every turn was `unscreenable`,
 * and screening was a no-op that reported no error. It was found because an
 * unrelated eval crashed on the same root cause — not because anything here
 * said so.
 *
 * ## Why in-process and not the usage recorder
 *
 * `@omadia/usage-telemetry` is the obvious host and is the wrong one: it
 * buffers into Postgres and, by its own contract, "no-ops until wired — in
 * in-memory-KG mode where no pool exists, `recordUsage` silently drops". A
 * security counter that disappears in exactly the deployments nobody is
 * watching rebuilds the original bug one layer up.
 *
 * So the counters live in memory, always work, and cost an integer increment.
 * They are process-scoped and reset on restart — a deliberate trade: this
 * answers "is screening working *now*", which is the question that was
 * unanswerable. Durable history belongs with the audit store the
 * `securityAuditSink` extension point is waiting for.
 */

import type { ScreenFailureCause } from './securityScreener.js';

/** A screening attempt's terminal state, as counted here. */
export type ScreenOutcomeKind = 'allow' | 'quarantine' | 'unscreenable';

export interface SecurityScreenMetrics {
  /** Attempts that reached a screener. Skipped turns are not counted. */
  readonly screened: number;
  readonly allowed: number;
  readonly quarantined: number;
  readonly unscreenable: number;
  /**
   * The number that actually matters. `unscreenable / screened`, or 0 when
   * nothing has been screened — deliberately not `NaN`, so a caller can render
   * it without a guard.
   */
  readonly unscreenableRate: number;
  /** Consecutive `unscreenable` results ending at the most recent attempt. */
  readonly consecutiveUnscreenable: number;
  /** Longest such run seen this process — survives a lull that resets the streak. */
  readonly worstConsecutiveUnscreenable: number;
  /** Per-cause totals. Every cause is present, so a reader needs no fallback. */
  readonly byCause: Readonly<Record<ScreenFailureCause, number>>;
}

/**
 * A run this long says "broken", not "busy".
 *
 * Chosen against the failure it exists to catch: the #748 bug produced a 100%
 * failure rate from the first turn, so any small threshold fires. It is not 1,
 * because a single miss is exactly the transient the fail-open policy is FOR,
 * and alerting on it would train operators to ignore the signal.
 */
export const UNSCREENABLE_STREAK_ALERT = 5;

const ZERO_BY_CAUSE: Record<ScreenFailureCause, number> = {
  'not-configured': 0,
  'provider-rejected': 0,
  'provider-unavailable': 0,
  'proxy-unreachable': 0,
  'unparseable-verdict': 0,
  unknown: 0,
};

interface MutableState {
  screened: number;
  allowed: number;
  quarantined: number;
  unscreenable: number;
  consecutive: number;
  worstConsecutive: number;
  byCause: Record<ScreenFailureCause, number>;
  /** Whether the current streak has already been announced, so a wedged
   *  screener logs once per episode instead of once per turn. */
  alerted: boolean;
}

function emptyState(): MutableState {
  return {
    screened: 0,
    allowed: 0,
    quarantined: 0,
    unscreenable: 0,
    consecutive: 0,
    worstConsecutive: 0,
    byCause: { ...ZERO_BY_CAUSE },
    alerted: false,
  };
}

let state: MutableState = emptyState();

/**
 * Count one screening attempt.
 *
 * Never throws: this is evidence, and evidence must not be able to break the
 * turn it is evidence about — the same contract as `emitSecurityAudit`.
 */
export function recordScreenOutcome(
  kind: ScreenOutcomeKind,
  cause?: ScreenFailureCause,
  onAlert: (metrics: SecurityScreenMetrics) => void = defaultAlert,
): void {
  try {
    state.screened += 1;
    if (kind === 'unscreenable') {
      state.unscreenable += 1;
      state.byCause[cause ?? 'unknown'] += 1;
      state.consecutive += 1;
      state.worstConsecutive = Math.max(state.worstConsecutive, state.consecutive);
      if (state.consecutive >= UNSCREENABLE_STREAK_ALERT && !state.alerted) {
        state.alerted = true;
        onAlert(getSecurityScreenMetrics());
      }
      return;
    }
    if (kind === 'quarantine') state.quarantined += 1;
    else state.allowed += 1;
    // A single success ends the episode: the next streak is a NEW incident and
    // deserves its own alert.
    state.consecutive = 0;
    state.alerted = false;
  } catch {
    /* counters are best-effort */
  }
}

function defaultAlert(metrics: SecurityScreenMetrics): void {
  console.error(
    `[security-screen] ${String(metrics.consecutiveUnscreenable)} consecutive unscreenable results — ` +
      'inbound screening is failing open on every turn. ' +
      `causes=${JSON.stringify(metrics.byCause)}`,
  );
}

/** An immutable snapshot. Callers cannot mutate the counters through it. */
export function getSecurityScreenMetrics(): SecurityScreenMetrics {
  const rate = state.screened === 0 ? 0 : state.unscreenable / state.screened;
  return {
    screened: state.screened,
    allowed: state.allowed,
    quarantined: state.quarantined,
    unscreenable: state.unscreenable,
    unscreenableRate: rate,
    consecutiveUnscreenable: state.consecutive,
    worstConsecutiveUnscreenable: state.worstConsecutive,
    byCause: { ...state.byCause },
  };
}

/** Test-only reset. Module state would otherwise leak between test files. */
export function resetSecurityScreenMetrics(): void {
  state = emptyState();
}
