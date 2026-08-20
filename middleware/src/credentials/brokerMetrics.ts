/**
 * #578 Phase 2 — counters for the credential broker, built the SAME shape as
 * `securityScreenMetrics.ts` (#749) per the scoping prompt's instruction to
 * reuse that pattern: count every outcome, don't just log it, because a log
 * line nobody is tailing and a broken broker produce the identical amount of
 * visible signal — none.
 *
 * Process-scoped, in-memory, reset on restart. That is the same deliberate
 * trade `securityScreenMetrics` makes and for the same reason: this answers
 * "is the broker refusing everything RIGHT NOW", which needs to survive an
 * in-memory-only deployment (no Postgres, no telemetry pool) precisely
 * because that is the mode most likely to have nobody watching a durable
 * audit sink. Durable per-request history is a `BrokerAuditEvent` sink's job
 * (`broker.ts`), not this module's.
 */

/** A broker decision's terminal state, as counted here. */
export type BrokerOutcomeKind = 'allow' | 'deny';

/**
 * Why a request was denied. Kept explicit (mirroring `ScreenFailureCause`)
 * so an operator reading the metrics can tell "the store is unreachable"
 * (an outage) apart from "nobody granted this" (working as intended) apart
 * from "a traversal-shaped path was rejected" (worth an eyebrow-raise) —
 * collapsing these into one free-text reason would make that undecidable
 * without string-matching.
 */
export type BrokerDenialReason =
  | 'credential-not-found'
  | 'credential-revoked'
  | 'not-a-service-credential'
  | 'no-active-grant'
  | 'grant-consumed-concurrently'
  | 'host-not-allowed'
  | 'method-not-allowed'
  | 'path-not-allowed'
  | 'invalid-broker-declaration'
  | 'store-unavailable'
  | 'dispatch-failed';

export const BROKER_DENIAL_REASONS: readonly BrokerDenialReason[] = Object.freeze([
  'credential-not-found',
  'credential-revoked',
  'not-a-service-credential',
  'no-active-grant',
  'grant-consumed-concurrently',
  'host-not-allowed',
  'method-not-allowed',
  'path-not-allowed',
  'invalid-broker-declaration',
  'store-unavailable',
  'dispatch-failed',
]);

export interface BrokerMetrics {
  /** Requests the broker decided on. A request that threw before reaching a
   *  decision (a programmer error, not a policy outcome) is not counted. */
  readonly requests: number;
  readonly allowed: number;
  readonly denied: number;
  /** `denied / requests`, or 0 when nothing has been decided yet —
   *  deliberately not `NaN`, so a caller can render it without a guard. */
  readonly deniedRate: number;
  /** Consecutive denials ending at the most recent decision. */
  readonly consecutiveDenied: number;
  /** Longest such run seen this process — survives a lull that resets the
   *  streak. */
  readonly worstConsecutiveDenied: number;
  /** Per-reason totals. Every reason is present, so a reader needs no
   *  fallback. Empty (all zero) for `allow`. */
  readonly byReason: Readonly<Record<BrokerDenialReason, number>>;
}

/**
 * A run this long says "the broker is refusing everything", not "an
 * operator is testing grants". Same reasoning and same threshold as
 * `UNSCREENABLE_STREAK_ALERT` (#749): chosen against the failure it exists
 * to catch (a systemic misconfiguration denies from the first request), not
 * tuned down to 1, because a single denial is exactly the normal case the
 * alert must not fire on.
 */
export const BROKER_DENIAL_STREAK_ALERT = 5;

function zeroByReason(): Record<BrokerDenialReason, number> {
  const entries = BROKER_DENIAL_REASONS.map((reason) => [reason, 0] as const);
  return Object.fromEntries(entries) as Record<BrokerDenialReason, number>;
}

interface MutableState {
  requests: number;
  allowed: number;
  denied: number;
  consecutive: number;
  worstConsecutive: number;
  byReason: Record<BrokerDenialReason, number>;
  /** Whether the current streak has already been announced, so a wedged
   *  broker logs once per episode instead of once per request. */
  alerted: boolean;
}

function emptyState(): MutableState {
  return {
    requests: 0,
    allowed: 0,
    denied: 0,
    consecutive: 0,
    worstConsecutive: 0,
    byReason: zeroByReason(),
    alerted: false,
  };
}

let state: MutableState = emptyState();

function defaultAlert(metrics: BrokerMetrics): void {
  console.error(
    `[credential-broker] ${String(metrics.consecutiveDenied)} consecutive denials — ` +
      `the broker is refusing every request. byReason=${JSON.stringify(metrics.byReason)}`,
  );
}

/**
 * Count one broker decision. Never throws: this is evidence, and evidence
 * must not be able to break the request it is evidence about — the same
 * contract `recordScreenOutcome` keeps.
 */
export function recordBrokerOutcome(
  kind: BrokerOutcomeKind,
  reason?: BrokerDenialReason,
  onAlert: (metrics: BrokerMetrics) => void = defaultAlert,
): void {
  try {
    state.requests += 1;
    if (kind === 'deny') {
      state.denied += 1;
      if (reason) state.byReason[reason] += 1;
      state.consecutive += 1;
      state.worstConsecutive = Math.max(state.worstConsecutive, state.consecutive);
      if (state.consecutive >= BROKER_DENIAL_STREAK_ALERT && !state.alerted) {
        state.alerted = true;
        onAlert(getBrokerMetrics());
      }
      return;
    }
    state.allowed += 1;
    // A single allow ends the episode: the next streak is a NEW incident and
    // deserves its own alert.
    state.consecutive = 0;
    state.alerted = false;
  } catch {
    /* counters are best-effort */
  }
}

/** An immutable snapshot. Callers cannot mutate the counters through it. */
export function getBrokerMetrics(): BrokerMetrics {
  const rate = state.requests === 0 ? 0 : state.denied / state.requests;
  return {
    requests: state.requests,
    allowed: state.allowed,
    denied: state.denied,
    deniedRate: rate,
    consecutiveDenied: state.consecutive,
    worstConsecutiveDenied: state.worstConsecutive,
    byReason: { ...state.byReason },
  };
}

/** Test-only reset. Module state would otherwise leak between test files. */
export function resetBrokerMetrics(): void {
  state = emptyState();
}
