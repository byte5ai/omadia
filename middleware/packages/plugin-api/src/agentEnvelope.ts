/**
 * Spec 2042 §5.2 / INV-1, 2, 6, 7 — the envelope of ONE agent, for a system
 * module that works on that agent's behalf (the canvas presentation helper,
 * `@omadia/ui-orchestrator`).
 *
 * A canvas turn names its agent (`agents.id`, chosen by the user per
 * canvas); the channel has already checked that the user may reach that
 * agent there. The helper then looks the agent's envelope up — the agent as a
 * chat agent that runs turns with its identity, instructions, tools, model
 * policy, grants and memory scope — deterministically and without a model.
 * An agent that cannot serve (unknown, disabled, not built) has no envelope:
 * the helper refuses the turn and never falls back to another agent.
 *
 * Given only to plugins of kind `system-module`.
 */

/** Service name of the resolver (`agentEnvelope@1`). */
export const AGENT_ENVELOPE_SERVICE_NAME = 'agentEnvelope';

/** One agent's envelope. `TAgent` is the channel SDK's `ChatAgent`. */
export interface AgentEnvelope<TAgent = unknown> {
  /** `agents.id` — the agent whose envelope this is */
  readonly agentId: string;
  /** runs turns in that agent's envelope */
  readonly agent: TAgent;
}

export interface AgentEnvelopeResolver<TAgent = unknown> {
  /** The envelope of the agent with this id, or `undefined` when it cannot serve. */
  resolve(agentId: string): AgentEnvelope<TAgent> | undefined;
}
