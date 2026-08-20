/**
 * #576 P2 — counters for the shell-normalizing command policy (#580), mirroring
 * `securityScreenMetrics.ts`'s #749 rationale verbatim: `guardToolCommands` (and,
 * from P2 on, the `execute` tool's own belt-and-braces org-floor check — see
 * `tools/executeTool.ts`) is fail-CLOSED by design, but before this module the
 * only trace of a denial or a broken policy load was whatever the caller chose
 * to log. "Count, don't just log" — the plan's own words for this phase — is
 * what turns "did the gate fire even once" from a grep exercise into a number
 * an operator dashboard can read.
 *
 * In-memory, process-scoped, reset on restart — the same trade-off
 * `securityScreenMetrics.ts` documents and for the same reason: this answers
 * "is the gate doing anything right now", which durable audit history (a
 * `commandPolicyAuditSink`, see `turnContext.ts`) is a separate, optional
 * concern for.
 */

export type CommandPolicyOutcomeKind =
  | 'allowed'
  | 'denied'
  | 'require_approval'
  | 'truncated'
  | 'resolve_failed';

export interface CommandPolicyMetrics {
  /** Every command a gate actually decided on (excludes calls where no
   *  command-shaped argument was present at all). */
  readonly total: number;
  readonly allowed: number;
  readonly denied: number;
  readonly requireApproval: number;
  /** Refused because normalization hit the substitution-depth cap — see
   *  `commandPolicy.ts`'s `NormalizedCommand.truncated`. */
  readonly truncated: number;
  /** The policy provider itself threw or a resolver was unavailable — the
   *  fail-closed path. A run of these means the gate is BROKEN, not that
   *  commands are merely being refused. */
  readonly resolveFailed: number;
  /** Per-rule-id tally for `denied` and `require_approval` decisions only
   *  (an `allowed` decision may also carry a rule id — an org-allowlist hit
   *  — but that is not what an operator needs to triage). Every key is a
   *  rule id that has fired at least once; absent keys are zero, not an
   *  error to guard against. */
  readonly byRuleId: Readonly<Record<string, number>>;
}

interface MutableState {
  total: number;
  allowed: number;
  denied: number;
  requireApproval: number;
  truncated: number;
  resolveFailed: number;
  byRuleId: Record<string, number>;
}

function emptyState(): MutableState {
  return {
    total: 0,
    allowed: 0,
    denied: 0,
    requireApproval: 0,
    truncated: 0,
    resolveFailed: 0,
    byRuleId: {},
  };
}

let state: MutableState = emptyState();

/**
 * Count one command-policy decision. Never throws — evidence must not be able
 * to break the call it is evidence about, same contract as
 * `recordScreenOutcome` / `emitSecurityAudit`.
 */
export function recordCommandPolicyOutcome(
  kind: CommandPolicyOutcomeKind,
  ruleId?: string,
): void {
  try {
    state.total += 1;
    switch (kind) {
      case 'allowed':
        state.allowed += 1;
        break;
      case 'denied':
        state.denied += 1;
        if (ruleId) state.byRuleId[ruleId] = (state.byRuleId[ruleId] ?? 0) + 1;
        break;
      case 'require_approval':
        state.requireApproval += 1;
        if (ruleId) state.byRuleId[ruleId] = (state.byRuleId[ruleId] ?? 0) + 1;
        break;
      case 'truncated':
        state.truncated += 1;
        break;
      case 'resolve_failed':
        state.resolveFailed += 1;
        break;
    }
  } catch {
    /* counters are best-effort */
  }
}

/** Immutable snapshot. Callers cannot mutate the live counters through it. */
export function getCommandPolicyMetrics(): CommandPolicyMetrics {
  return {
    total: state.total,
    allowed: state.allowed,
    denied: state.denied,
    requireApproval: state.requireApproval,
    truncated: state.truncated,
    resolveFailed: state.resolveFailed,
    byRuleId: { ...state.byRuleId },
  };
}

/** Test-only reset. Module state would otherwise leak between test files. */
export function resetCommandPolicyMetrics(): void {
  state = emptyState();
}
