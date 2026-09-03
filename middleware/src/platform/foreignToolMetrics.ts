/**
 * #1008 / #1017 item 4 — counters for FOREIGN tool calls, built the same shape
 * as `brokerMetrics.ts` (#578) and `securityScreenMetrics` (#749): count every
 * occurrence, don't just log it, because a log line nobody is tailing and a
 * broken spawn gate produce the identical amount of visible signal — none.
 *
 * A foreign tool call is one the subscription-CLI agent made OUTSIDE omadia's
 * loopback MCP server, i.e. one of the CLI's own built-in tools (`Bash`,
 * `Read`, …). OM-81 (#991) removes those at spawn time via `--tools ""`, a
 * deny list and `--permission-mode dontAsk`, so the expected value of every
 * counter here is ZERO. A non-zero count means the gate failed and the agent
 * reached the host machine — which is why this alerts on EVERY occurrence
 * rather than once per episode the way `brokerMetrics` does for denial
 * streaks: there is no benign steady state to suppress.
 *
 * Process-scoped, in-memory, reset on restart. Same deliberate trade as the
 * two modules above: this answers "is the gate leaking RIGHT NOW", which has
 * to survive an in-memory-only deployment (no Postgres, no telemetry pool)
 * precisely because that is the mode most likely to have nobody watching a
 * durable audit sink.
 */

export interface ForeignToolMetrics {
  /** Foreign tool calls observed since process start. Expected: 0. */
  readonly calls: number;
  /** Per-tool-name counts, so an operator can see WHICH built-in leaked. */
  readonly byTool: Readonly<Record<string, number>>;
  /** Per-agent-slug counts, so a single misconfigured agent is identifiable. */
  readonly byAgent: Readonly<Record<string, number>>;
  /** Epoch ms of the first occurrence, or undefined while the count is 0. */
  readonly firstSeenAt: number | undefined;
  /** Epoch ms of the most recent occurrence, or undefined while 0. */
  readonly lastSeenAt: number | undefined;
}

interface MutableState {
  calls: number;
  byTool: Record<string, number>;
  byAgent: Record<string, number>;
  firstSeenAt: number | undefined;
  lastSeenAt: number | undefined;
}

function emptyState(): MutableState {
  return {
    calls: 0,
    byTool: {},
    byAgent: {},
    firstSeenAt: undefined,
    lastSeenAt: undefined,
  };
}

let state: MutableState = emptyState();

function defaultAlert(toolName: string, agentSlug: string, calls: number): void {
  console.error(
    `[security] FOREIGN tool call "${toolName}" from agent "${agentSlug}" — ` +
      'this call did NOT go through omadia\'s loopback MCP server, so the ' +
      'subscription-CLI spawn gate (OM-81, #991) did not hold. ' +
      `foreignCallsThisProcess=${String(calls)}`,
  );
}

/**
 * Count one foreign tool call and announce it. Never throws: this is
 * evidence, and evidence must not be able to break the turn it is evidence
 * about — the same contract `recordBrokerOutcome` keeps.
 */
export function recordForeignToolCall(
  toolName: string,
  agentSlug: string,
  onAlert: (toolName: string, agentSlug: string, calls: number) => void = defaultAlert,
): void {
  try {
    const now = Date.now();
    state.calls += 1;
    state.byTool[toolName] = (state.byTool[toolName] ?? 0) + 1;
    state.byAgent[agentSlug] = (state.byAgent[agentSlug] ?? 0) + 1;
    state.firstSeenAt ??= now;
    state.lastSeenAt = now;
    onAlert(toolName, agentSlug, state.calls);
  } catch {
    /* counters are best-effort */
  }
}

/** An immutable snapshot. Callers cannot mutate the counters through it. */
export function getForeignToolMetrics(): ForeignToolMetrics {
  return {
    calls: state.calls,
    byTool: { ...state.byTool },
    byAgent: { ...state.byAgent },
    firstSeenAt: state.firstSeenAt,
    lastSeenAt: state.lastSeenAt,
  };
}

/** Test-only reset. Module state would otherwise leak between test files. */
export function resetForeignToolMetrics(): void {
  state = emptyState();
}
