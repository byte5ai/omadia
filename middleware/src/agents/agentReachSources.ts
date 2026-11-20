import { mcpToolNameFromRef, type AgentGraphStore } from '@omadia/orchestrator';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import { isCapabilityPlugin } from '../plugins/capabilityPlugins.js';
import {
  computeAgentReach,
  declaredSideEffects,
  discoveredMcpTools,
  type AgentReach,
  type ReachEnvironment,
  type ReachGrants,
} from './agentReach.js';

/**
 * #2054 — loads what `computeAgentReach` decides on: the connected systems of
 * the instance and one agent's grants. Every source is optional, like the
 * operator router's getters: without the catalog or installed registry there
 * are no plugin systems, without the agent graph store no MCP systems — the
 * reach then shows what can be known, never a guess.
 */
export interface ReachSources {
  readonly catalog?: Pick<PluginCatalog, 'get'> | undefined;
  readonly installed?: Pick<InstalledRegistry, 'list'> | undefined;
  readonly graph?:
    | Pick<
        AgentGraphStore,
        'listMcpServers' | 'listToolGrantsForAgent' | 'listPluginMcpGrantsForPlugins'
      >
    | undefined;
}

/** One `agent_plugins` row, as far as reach needs it. */
export interface ReachPluginRow {
  readonly pluginId: string;
  readonly enabled: boolean;
}

export async function loadReachEnvironment(sources: ReachSources): Promise<ReachEnvironment> {
  const { catalog, installed, graph } = sources;
  const plugins =
    catalog && installed
      ? installed.list().flatMap((entry) => {
          const catalogEntry = catalog.get(entry.id);
          if (!catalogEntry || !isCapabilityPlugin(catalogEntry.plugin)) return [];
          return [
            {
              id: entry.id,
              name: catalogEntry.plugin.name,
              sideEffects: declaredSideEffects(catalogEntry.manifest),
            },
          ];
        })
      : [];
  const servers = graph ? await graph.listMcpServers() : [];
  return {
    plugins,
    mcpServers: servers
      .filter((s) => s.status === 'enabled')
      .map((s) => ({ id: s.id, name: s.name, tools: discoveredMcpTools(s.discoveredTools) })),
  };
}

/**
 * `agentId` `undefined`: an agent that does not exist yet (the first-run
 * flow's create path) — it has no tool grants of its own, only the plugin
 * rows it is about to get.
 */
export async function loadReachGrants(
  sources: ReachSources,
  env: ReachEnvironment,
  agentId: string | undefined,
  pluginRows: readonly ReachPluginRow[],
): Promise<ReachGrants> {
  const plugins = pluginRows.map((p) => ({ pluginId: p.pluginId, enabled: p.enabled }));
  const graph = sources.graph;
  if (!graph) return { plugins, mcpToolGrants: [], pluginMcpGrants: [] };
  const serverNames = new Map(env.mcpServers.map((s) => [s.id, s.name]));
  const [toolGrants, pluginMcpGrants] = await Promise.all([
    agentId === undefined ? Promise.resolve([]) : graph.listToolGrantsForAgent(agentId),
    graph.listPluginMcpGrantsForPlugins(plugins.map((p) => p.pluginId)),
  ]);
  return {
    plugins,
    mcpToolGrants: toolGrants.flatMap((g) => {
      if (g.toolKind !== 'mcp' || !g.mcpServerId) return [];
      const serverName = serverNames.get(g.mcpServerId);
      if (serverName === undefined) return [];
      return [{ mcpServerId: g.mcpServerId, toolName: mcpToolNameFromRef(g.toolRef, serverName) }];
    }),
    pluginMcpGrants: pluginMcpGrants.map((g) => ({
      pluginId: g.pluginId,
      mcpServerId: g.mcpServerId,
    })),
  };
}

/** The reach of one agent with the given plugin rows (current or proposed). */
export async function loadAgentReach(
  sources: ReachSources,
  env: ReachEnvironment,
  agentId: string,
  pluginRows: readonly ReachPluginRow[],
): Promise<AgentReach> {
  return computeAgentReach(env, await loadReachGrants(sources, env, agentId, pluginRows));
}

/** The reach as the operator API answers it. */
export function reachDto(reach: AgentReach): {
  systems: Array<{
    key: string;
    type: 'plugin' | 'mcp_server';
    ref: string;
    name: string;
    read: boolean;
    write: boolean;
    declared: boolean;
    via: string[];
  }>;
  connected_systems: number;
  covers_every_system: boolean;
  broad: boolean;
} {
  return {
    systems: reach.systems.map((s) => ({
      key: s.key,
      type: s.type,
      ref: s.ref,
      name: s.name,
      read: s.read,
      write: s.write,
      declared: s.declared,
      via: [...s.via],
    })),
    connected_systems: reach.connectedSystems,
    covers_every_system: reach.coversEverySystem,
    broad: reach.broad,
  };
}
