import type { LlmProvider } from '@omadia/llm-provider';
import { turnContext } from './turnContext.js';

/**
 * Sub-agent model fallback: a `LocalSubAgent` whose configured model fails
 * for availability reasons (unknown model, rejected key, unreachable
 * endpoint, rate limit after the retry budget — `fallbackReasonFor`) before
 * producing output continues on the model the orchestrator runs this turn
 * on. The typical trigger is a stale model id after a provider switch: a
 * manifest or `SUB_AGENT_MODEL` that still names a Claude model on a host
 * that now runs on another provider would otherwise fail every delegation
 * with `model_not_found`.
 */

/** Where a sub-agent's model calls run. */
export interface SubAgentExecution {
  readonly provider: LlmProvider;
  readonly model: string;
}

/**
 * The fallback for a sub-agent running on `primary`: the orchestrator's
 * execution of the current turn (`TurnContextValue.orchestratorExecution`).
 * None outside an orchestrator turn, and none when it is the same
 * provider+model as the primary — there is nothing to hop to.
 */
export function orchestratorFallbackFor(
  primary: SubAgentExecution,
): SubAgentExecution | undefined {
  const exec = turnContext.current()?.orchestratorExecution?.value;
  if (!exec) return undefined;
  if (exec.provider.id === primary.provider.id && exec.model === primary.model) {
    return undefined;
  }
  return exec;
}

/** How long a sub-agent skips its primary after a configuration failure. */
export const PRIMARY_MODEL_COOLDOWN_MS = 10 * 60_000;

/**
 * Failures that will reproduce on every call until an operator changes the
 * configuration. Transient ones (rate limit, overload, unreachable) only hop
 * the run they hit; the provider-wide breaker for those is the orchestrator's.
 */
const CONFIGURATION_FAILURES: ReadonlySet<string> = new Set(['model_not_found', 'auth']);

/**
 * Per-sub-agent memory of a primary model that failed for a configuration
 * reason, so the following runs go straight to the fallback instead of paying
 * the failing request again on every delegation.
 */
export class PrimaryModelCooldown {
  private until = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly durationMs: number = PRIMARY_MODEL_COOLDOWN_MS,
  ) {}

  isActive(): boolean {
    return this.now() < this.until;
  }

  /** Records a hop; returns whether it opened the cooldown. */
  recordFallback(reason: string): boolean {
    if (!CONFIGURATION_FAILURES.has(reason)) return false;
    this.until = this.now() + this.durationMs;
    return true;
  }
}
