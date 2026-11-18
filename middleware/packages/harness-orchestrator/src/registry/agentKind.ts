/**
 * #2060 — the kind of an agent (migration 0067).
 *
 * A `facilitator` is a kind of agent that only moderates. It inherits what
 * makes an agent a virtual employee (identity, personality, its own channel
 * identity, model policy) and deliberately omits what would make it partial:
 * business grants, memory, consultation, being the default agent, persona
 * skills, the fast path (spec 2043 §2.3).
 *
 * The kind is fixed at creation. The database refuses a change (trigger
 * `agents_kind_immutable`), so no facilitator ever carries grants or memory
 * from a former life as a standard agent.
 *
 * Deny-default narrowing reads anything unrecognised as `'standard'`: a
 * pre-0067 database has no column, and every agent that existed then IS a
 * standard agent. The omissions are additionally enforced at write time, so
 * a facilitator can only come into being through the path that sets the kind
 * explicitly.
 */

export const AGENT_KINDS = ['standard', 'facilitator'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export function parseAgentKind(raw: unknown): AgentKind {
  return raw === 'facilitator' ? 'facilitator' : 'standard';
}

export function isFacilitatorKind(agent: { readonly kind?: AgentKind } | undefined | null): boolean {
  return agent?.kind === 'facilitator';
}

/** What a facilitator is refused. One code per omission of spec 2043 §2.3. */
export type FacilitatorOmission =
  | 'plugin_grant'
  | 'tool_grant'
  | 'memory'
  | 'default_agent'
  | 'channel_binding'
  | 'persona_skill'
  | 'fast_path'
  | 'agent_to_agent'
  | 'consultation'
  | 'sub_agent'
  | 'assistance';

const OMISSION_REASON: Record<FacilitatorOmission, string> = {
  plugin_grant:
    'a facilitator only gets the tools of the facilitation engine; business plugins would make it partial',
  tool_grant:
    'a facilitator only gets the tools of the facilitation engine; other tool grants would make it partial',
  memory:
    'a facilitator has no general memory; its only memory is the record of each facilitation',
  default_agent:
    'a facilitator cannot be the default agent; it never answers for or as someone',
  channel_binding:
    'a facilitator speaks only as its own channel identity; a channel binding would let it answer through another bot',
  persona_skill: 'a facilitator has no persona skills; it never answers as someone else',
  fast_path: 'a facilitator does not use the fast path',
  agent_to_agent:
    'a facilitator neither talks to other agents nor is addressed by them',
  consultation: 'a facilitator neither consults other agents nor is consulted by them',
  sub_agent: 'a facilitator has no sub-agents and is not attached to other agents',
  assistance: 'a facilitator is not an assistant; it only moderates',
};

/**
 * Thrown wherever a facilitator is offered something it must not have.
 * A distinct class so routes map it to a 4xx with a stable `code`.
 */
export class FacilitatorOmissionError extends Error {
  readonly code = 'facilitator_omission';
  constructor(
    readonly omission: FacilitatorOmission,
    readonly agentSlug: string,
  ) {
    super(`agent "${agentSlug}" is a facilitator: ${OMISSION_REASON[omission]}`);
    this.name = 'FacilitatorOmissionError';
  }
}

/**
 * THE seam for "this is not for facilitators". Every write path and every
 * runtime path that would hand a facilitator one of the omitted things calls
 * it; epic #2042 (consultation between agents) reuses it for both directions
 * of a consultation edge.
 */
export function assertNotFacilitator(
  agent: { readonly slug: string; readonly kind?: AgentKind } | undefined | null,
  omission: FacilitatorOmission,
): void {
  if (agent && isFacilitatorKind(agent)) {
    throw new FacilitatorOmissionError(omission, agent.slug);
  }
}
