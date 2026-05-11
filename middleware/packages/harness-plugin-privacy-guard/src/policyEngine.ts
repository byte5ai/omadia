/**
 * Policy engine — maps `(detection-type, agent, tenant-mode)` to the
 * `DetectionAction` the service applies to each hit.
 *
 * Slice 1b ships a hard-coded default table. Slice 2 makes this
 * tenant-configurable; Slice 3 wires the `data-residency` mode to the
 * Ollama-sidecar routing decision. Keeping the engine pure (no IO)
 * lets the host call it tens of times per turn without overhead.
 */

import type { DetectionAction, PolicyMode } from '@omadia/plugin-api';

export interface PolicyDecision {
  readonly action: DetectionAction;
  /** Optional reason hint surfaced via the receipt's `routingReason`
   *  when the policy forces a non-default routing (e.g. blocked api-key). */
  readonly routingReason?: string;
}

/**
 * Default action per detection type. Reflects the matrix from the
 * Privacy-Proxy HANDOFF (Lock 4): structured PII tokenises so the user
 * still sees real values in the assistant reply; api-keys redact
 * irreversibly because they have no business turning up in any answer.
 *
 * Slice 3.1 widens this to `Record<string, …>` so add-on detectors can
 * emit free-form types (`pii.name`, `business.contract_clause`, …)
 * without a schema change. Unknown types fall back to `tokenized` —
 * the safer default: detected but reversible, so the user still sees
 * real values in the answer without the original ever leaving the host.
 */
const DEFAULT_ACTIONS: Readonly<Record<string, DetectionAction>> = {
  'pii.email': 'tokenized',
  'pii.iban': 'tokenized',
  'pii.phone': 'tokenized',
  'pii.credit_card': 'tokenized',
  'pii.api_key': 'redacted',
};

/**
 * Decide what to do with a single detection hit, given the active
 * policy mode + agent. Pure function — no side effects, no IO.
 */
export function decide(input: {
  readonly type: string;
  readonly policyMode: PolicyMode;
  readonly agentId?: string;
}): PolicyDecision {
  // Slice 1b: agent-id is accepted for forward-compat but not yet
  // consulted. Slice 2 adds the per-agent override layer.
  void input.agentId;

  // Data-residency in Slice 1b only differs from pii-shield in that a
  // hard-redact stays a hard-redact (no surprise upgrade). Tenant-label
  // routing to the local sidecar arrives in Slice 3; until then the
  // mode is recorded in the receipt for visibility but does not change
  // per-detection actions.
  void input.policyMode;

  const action = DEFAULT_ACTIONS[input.type] ?? 'tokenized';
  if (action === 'redacted' && input.type === 'pii.api_key') {
    return {
      action,
      routingReason: 'strict policy: api-key detected',
    };
  }
  return { action };
}

/**
 * Aggregate policy decisions across all hits in a turn into the routing
 * outcome the host obeys. Slice 1b supports two outcomes:
 *
 *   - `public-llm`: every detection was tokenised, redacted, or passed.
 *     The transformed payload is safe for the public LLM call.
 *   - `blocked`:    at least one detection's policy decision raised a
 *     `routingReason` AND its action is `blocked`. Slice 1b never
 *     auto-promotes hits to `blocked`; this branch is reserved for
 *     Slice 3 (`data-residency` + customer_data label). Kept here so
 *     the routing-decision plumbing already works end-to-end.
 *
 * `local-llm` lands in Slice 3 along with the Ollama sidecar.
 */
export function deriveRouting(decisions: ReadonlyArray<PolicyDecision>): {
  readonly routing: 'public-llm' | 'blocked';
  readonly routingReason?: string;
} {
  for (const d of decisions) {
    if (d.action === 'blocked') {
      return d.routingReason
        ? { routing: 'blocked', routingReason: d.routingReason }
        : { routing: 'blocked' };
    }
  }
  return { routing: 'public-llm' };
}
