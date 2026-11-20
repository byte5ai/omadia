import type { AuditActor, AuditEntryInput } from '../auth/adminAuditLog.js';
import {
  computeAgentReach,
  requiresBroadReachConfirmation,
  type AgentReach,
  type ReachGrants,
} from './agentReach.js';
import {
  loadReachEnvironment,
  loadReachGrants,
  reachDto,
  type ReachPluginRow,
  type ReachSources,
} from './agentReachSources.js';

/**
 * #2054 — spec 2042 §5.7: granting a capability that gives an agent access to
 * every connected system, or designating such an agent as the default agent,
 * needs an explicit operator confirmation and is audited.
 *
 * {@link requireBroadReachConfirmation} is the one check every such write
 * calls BEFORE it writes: the plugin grant routes
 * (`PATCH|PUT /api/v1/operator/agents/:slug/plugins`), the MCP tool grant
 * route (`PUT /api/v1/operator/mcp-grants`), the first-run flow, and the
 * default-agent assignment (change `default_agent`). A refusal is HTTP 409
 * with the typed error {@link BROAD_REACH_CONFIRMATION_REQUIRED}; the request
 * passes when it carries `confirmBroadReach: true`. A confirmed change comes
 * back with the admin audit entry the caller records AFTER its write
 * succeeded (`agent.broad_reach_grant` / `agent.broad_reach_default`), so a
 * failed write leaves no row claiming a change that did not happen.
 */
export const BROAD_REACH_CONFIRMATION_REQUIRED = 'broad_reach_confirmation_required';

/** `grant`: a grant change. `default_agent`: the agent becomes a default agent. */
export type BroadReachChange = 'grant' | 'default_agent';

/** What a grant change adds to the agent's current grants. */
export interface ProposedGrants {
  /** Replaces the agent's `agent_plugins` rows. */
  readonly plugins?: readonly ReachPluginRow[];
  /** MCP tool grants added to the agent's own. Revokes are not modelled: a
   *  revoke never widens a reach, so leaving it out can only over-ask. */
  readonly addMcpToolGrants?: readonly { readonly mcpServerId: string; readonly toolName: string }[];
}

export interface BroadReachConfirmationInput {
  readonly sources: ReachSources;
  readonly agent: { readonly id: string; readonly slug: string };
  readonly change: BroadReachChange;
  /** The agent's current `agent_plugins` rows. */
  readonly currentPlugins: readonly ReachPluginRow[];
  /** For `grant`: what the change sets. Ignored for `default_agent`. */
  readonly proposed?: ProposedGrants;
  /** The request carried `confirmBroadReach: true`. */
  readonly confirmed: boolean;
  /** Who asks (`auditActorFromRequest(req)`). */
  readonly actor: AuditActor;
}

export interface BroadReachRefusalBody {
  readonly error: typeof BROAD_REACH_CONFIRMATION_REQUIRED;
  readonly message: string;
  readonly change: BroadReachChange;
  readonly slug: string;
  readonly reach: ReturnType<typeof reachDto>;
}

export type BroadReachConfirmation =
  | {
      readonly ok: true;
      /** Record after the write succeeded; absent when nothing broad happened. */
      readonly audit: AuditEntryInput | undefined;
      readonly before: AgentReach;
      readonly after: AgentReach;
    }
  | { readonly ok: false; readonly status: 409; readonly body: BroadReachRefusalBody };

export async function requireBroadReachConfirmation(
  input: BroadReachConfirmationInput,
): Promise<BroadReachConfirmation> {
  const env = await loadReachEnvironment(input.sources);
  const current = await loadReachGrants(input.sources, env, input.agent.id, input.currentPlugins);
  const before = computeAgentReach(env, current);
  let after = before;
  if (input.change === 'grant' && input.proposed) {
    // Loaded again for the proposed plugins: their `plugin_mcp_grants` widen
    // the reach too.
    const proposedPlugins = input.proposed.plugins ?? input.currentPlugins;
    const next = input.proposed.plugins
      ? await loadReachGrants(input.sources, env, input.agent.id, proposedPlugins)
      : current;
    after = computeAgentReach(env, withAddedMcpGrants(next, input.proposed));
  }
  const needed =
    input.change === 'grant' ? requiresBroadReachConfirmation(before, after) : after.broad;
  if (needed && !input.confirmed) {
    return { ok: false, status: 409, body: broadReachRefusal(input.agent.slug, after, input.change) };
  }
  const audit: AuditEntryInput | undefined = needed
    ? {
        actor: input.actor,
        action: input.change === 'grant' ? 'agent.broad_reach_grant' : 'agent.broad_reach_default',
        target: `agent:${input.agent.id}`,
        before: broadReachAuditState(before),
        after: { ...broadReachAuditState(after), slug: input.agent.slug, confirmed: true },
      }
    : undefined;
  return { ok: true, audit, before, after };
}

/** `current` with one row set (added or replaced), for a single toggle. */
export function withPluginRow(
  current: readonly ReachPluginRow[],
  row: ReachPluginRow,
): ReachPluginRow[] {
  return [...current.filter((r) => r.pluginId !== row.pluginId), row];
}

function withAddedMcpGrants(grants: ReachGrants, proposed: ProposedGrants): ReachGrants {
  const added = proposed.addMcpToolGrants ?? [];
  return added.length === 0
    ? grants
    : { ...grants, mcpToolGrants: [...grants.mcpToolGrants, ...added] };
}

function broadReachRefusal(
  slug: string,
  reach: AgentReach,
  change: BroadReachChange,
): BroadReachRefusalBody {
  const what =
    change === 'grant'
      ? `this grant gives agent "${slug}" access to every connected system`
      : `agent "${slug}" has access to every connected system and would become a default agent`;
  return {
    error: BROAD_REACH_CONFIRMATION_REQUIRED,
    message: `${what} (${String(reach.connectedSystems)}); send { "confirmBroadReach": true } to confirm`,
    change,
    slug,
    reach: reachDto(reach),
  };
}

function broadReachAuditState(reach: AgentReach): {
  systems: string[];
  connected_systems: number;
  broad: boolean;
} {
  return {
    systems: reach.systems.map((s) => s.key),
    connected_systems: reach.connectedSystems,
    broad: reach.broad,
  };
}
