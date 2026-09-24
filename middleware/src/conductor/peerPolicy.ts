// #1018 W1 — the peer gate, in one place.
//
// W0 added the two switches (`agents.agent_to_agent`, `agent_channel_policies`).
// This is the single evaluator every consumer goes through — the discussion
// start, every relayed utterance, and the roster the calling agent sees — so
// "may agent X talk to peers in chat Y" has exactly one answer in the process.
//
// The rule is AND: the agent's own switch must be `'on'` AND an enabled policy
// row must exist for the pair. Both halves are deny-default. When the store
// cannot be read (no database, transient failure) the gate answers `false`:
// the failure direction that keeps an agent silent is the one that changes
// nothing a human did not ask for.

import {
  isAgentToAgentEnabled,
  type AgentChannelPolicyRow,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';

/** `(channelType, conversationId, agentSlug) → may this agent talk to peers here?` */
export type PeerGate = (
  channelType: string,
  conversationId: string,
  agentSlug: string,
) => Promise<boolean>;

export interface PeerPolicyDeps {
  getRegistry: () => Pick<OrchestratorRegistry, 'get'> | undefined;
  /** The policy rows for one chat, or undefined when no store is wired. */
  listChannelPeerPolicies?: (
    channelType: string,
    channelKey: string,
  ) => Promise<readonly AgentChannelPolicyRow[]>;
  log?: (msg: string) => void;
}

/**
 * #1018 — the `chatPeerAgents@1` service: which peer AGENTS the agent
 * answering the current turn may see in this chat. Everything is derived from
 * the ambient turn (where, and which bot received it) — a caller supplies
 * nothing, so it can see no chat but its own. Every entry passed the gate for
 * BOTH sides: the caller and the peer. Empty outside a channel turn.
 */
export function createChatPeerAgentsProvider(deps: {
  resolveTurn: () => { channelType: string; conversationId: string; botChannelKey?: string } | undefined;
  resolveOpener: (channelType: string, botChannelKey: string) => string | undefined;
  /** Present bots with their identity key, e.g. Teams `28:<appId>`. */
  listPresent: (
    channelType: string,
    conversationId: string,
  ) => Promise<readonly { slug: string; name: string; channelKey: string }[]>;
  peerGate: PeerGate;
}): () => Promise<
  Array<{
    channelUserId: string;
    aadObjectId: null;
    displayName: string;
    email: null;
    userPrincipalName: null;
    kind: 'agent';
    agentSlug: string;
  }>
> {
  return async () => {
    const turn = deps.resolveTurn();
    if (!turn || !turn.botChannelKey) return [];
    const caller = deps.resolveOpener(turn.channelType, turn.botChannelKey);
    if (!caller) return [];
    if (!(await deps.peerGate(turn.channelType, turn.conversationId, caller))) return [];
    const present = (await deps.listPresent(turn.channelType, turn.conversationId)).filter(
      (p) => p.slug !== caller,
    );
    const verdicts = await Promise.all(
      present.map((p) => deps.peerGate(turn.channelType, turn.conversationId, p.slug)),
    );
    return present
      .filter((_, i) => verdicts[i] === true)
      .map((p) => ({
        channelUserId: p.channelKey,
        aadObjectId: null,
        displayName: p.name,
        email: null,
        userPrincipalName: null,
        kind: 'agent' as const,
        agentSlug: p.slug,
      }));
  };
}

export function createPeerGate(deps: PeerPolicyDeps): PeerGate {
  return async (channelType, conversationId, agentSlug) => {
    const agent = deps.getRegistry()?.get(agentSlug)?.agent;
    if (!agent) return false;
    if (!deps.listChannelPeerPolicies) return false;
    let rows: readonly AgentChannelPolicyRow[];
    try {
      rows = await deps.listChannelPeerPolicies(channelType, conversationId);
    } catch (err) {
      deps.log?.(
        `[conductor] peer-policy lookup for ${channelType}/${conversationId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    const policy = rows.find((r) => r.agentId === agent.id);
    return isAgentToAgentEnabled(agent.agentToAgent, policy);
  };
}
