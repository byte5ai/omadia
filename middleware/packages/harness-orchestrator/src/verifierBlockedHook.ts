import type { VerifierVerdict } from '@omadia/verifier';

import type { ChatTurnInput } from './orchestrator.js';
import type { TurnHookRunner } from './turnHooks.js';

/**
 * #133 (E6) — fire-and-forget signal that this turn's answer was
 * verifier-blocked. Keyed by session scope (the plan-runner looks up the
 * scope's latest plan). Never throws, never blocks the response.
 */
export function fireVerifierBlockedHook(
  reg: TurnHookRunner | undefined,
  agentSlug: string,
  input: ChatTurnInput,
  verdict: VerifierVerdict,
): void {
  const scope = input.sessionScope;
  if (!reg || !scope) return;
  const contradictions = (verdict as { contradictions?: unknown[] })
    .contradictions;
  const n = Array.isArray(contradictions) ? contradictions.length : 0;
  const reason = `verifier blocked (${String(n)} contradiction${
    n === 1 ? '' : 's'
  })`;
  void reg
    .run(
      'onVerifierBlocked',
      {
        turnId: scope,
        sessionScope: scope,
        ...(input.userId ? { userId: input.userId } : {}),
        // Per-orchestrator isolation: same Agent slug the orchestrator
        // stamps on its hooks, so the plan-runner qualifies the scope
        // identically and finds this Agent's plan.
        agentSlug,
      },
      { blockReason: reason },
    )
    .catch(() => undefined);
}
