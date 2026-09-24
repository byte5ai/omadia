/**
 * #1018 — the agent-to-agent switches (migration 0058).
 *
 * Agent-to-agent conversation is an orchestrator-internal relay (the
 * Conductor `discussion` pattern): no platform delivers one bot's message to
 * another, so the kernel fans turns out itself and each agent posts under its
 * own bot. Being kernel-owned, the relay can also be kernel-GATED — and the
 * gate has two halves that must BOTH be open (AND, never OR):
 *
 *   1. the agent's own switch, `agents.agent_to_agent` — "may this agent talk
 *      to peers at all?"
 *   2. the pair's switch, `agent_channel_policies(channel_type, channel_key,
 *      agent_id)` — "may it do so in THIS chat?"
 *
 * Both halves are deny-default: an unknown/NULL column value reads `'off'`,
 * a missing policy row reads `false`. The failure direction that changes
 * nothing is the safe one — flipping an agent's peer talk ON because a value
 * was unrecognised would be the exact inverse of what a rolling deploy needs.
 */

export const AGENT_TO_AGENT_MODES = ['off', 'on'] as const;
export type AgentToAgentMode = (typeof AGENT_TO_AGENT_MODES)[number];

/** Deny-default narrowing of the persisted `agent_to_agent` text. */
export function parseAgentToAgentMode(raw: unknown): AgentToAgentMode {
  return raw === 'on' ? 'on' : 'off';
}

/** One `(channel, agent)` enablement row. */
export interface AgentChannelPolicyRow {
  readonly channelType: string;
  readonly channelKey: string;
  readonly agentId: string;
  readonly agentToAgent: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentChannelPolicyInput {
  readonly channelType: string;
  readonly channelKey: string;
  readonly agentId: string;
  readonly agentToAgent: boolean;
}

/**
 * The effective rule, in one place so every caller (relay, roster, UI
 * read-out) agrees: the agent's switch AND the pair's switch.
 */
export function isAgentToAgentEnabled(
  agentMode: AgentToAgentMode | undefined,
  policy: Pick<AgentChannelPolicyRow, 'agentToAgent'> | undefined,
): boolean {
  return parseAgentToAgentMode(agentMode) === 'on' && policy?.agentToAgent === true;
}
