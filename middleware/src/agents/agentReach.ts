/**
 * #2054 — the reach of an agent (spec 2042 §5.7, INV-8): every connected
 * system it can read or write through its grants, read and write marked
 * separately. Pure: the caller loads the instance's systems and the agent's
 * grants (`agentReachSources.ts`), this module only decides.
 *
 * WHAT A CONNECTED SYSTEM IS
 * Every installed capability plugin (`capabilityPlugins.ts`) and every enabled
 * MCP server. Each is one system; an agent reaches it through
 *  - an enabled `agent_plugins` row of that plugin, or
 *  - an MCP tool grant on the server (the agent's own or one of its internal
 *    helpers'), or a `plugin_mcp_grants` row of a plugin the agent holds.
 *
 * READ AND WRITE
 * Deterministic, from what the plugin or server declares:
 *  - a plugin: its manifest capabilities' `side_effects` (`read` | `write` |
 *    `none`). A plugin that declares none is shown as read AND write, marked
 *    undeclared — the same conservative rule the agent runtime applies, where
 *    every plugin tool counts as a write (`orchestrator.ts`, `replayClassOf`).
 *  - an MCP server: each reachable tool's `annotations.readOnlyHint` from the
 *    last discovery. `true` is a read, anything else a write (the MCP default).
 *    A tool the discovery does not know, or a server granted whole with no
 *    discovered tools, counts as read and write, undeclared.
 *
 * BROAD REACH
 * An agent whose reach covers every connected system of the instance, and
 * there are at least {@link MIN_BROAD_REACH_SYSTEMS}, holds the master key to
 * all of them. Granting that, or making such an agent the default agent, needs
 * an explicit operator confirmation and is audited (§5.7).
 */

export type SideEffect = 'read' | 'write' | 'none';

const SIDE_EFFECTS: ReadonlySet<string> = new Set(['read', 'write', 'none']);

/** Fewer connected systems than this are never "every connected system". */
export const MIN_BROAD_REACH_SYSTEMS = 2;

/** An installed capability plugin, as far as reach needs it. */
export interface ReachPlugin {
  readonly id: string;
  readonly name: string;
  /** The manifest capabilities' `side_effects`; empty = none declared. */
  readonly sideEffects: readonly SideEffect[];
}

/** One tool of an MCP server's last discovery. */
export interface ReachMcpTool {
  readonly name: string;
  /** `annotations.readOnlyHint`; `undefined` when not annotated. */
  readonly readOnly: boolean | undefined;
}

/** An enabled MCP server. */
export interface ReachMcpServer {
  readonly id: string;
  readonly name: string;
  readonly tools: readonly ReachMcpTool[];
}

/** The connected systems of the instance. */
export interface ReachEnvironment {
  readonly plugins: readonly ReachPlugin[];
  readonly mcpServers: readonly ReachMcpServer[];
}

/** What one agent holds. */
export interface ReachGrants {
  readonly plugins: readonly { readonly pluginId: string; readonly enabled: boolean }[];
  /** MCP tool grants of the agent and its internal helpers. */
  readonly mcpToolGrants: readonly { readonly mcpServerId: string; readonly toolName: string }[];
  /** `plugin_mcp_grants` of the plugins assigned to the agent. */
  readonly pluginMcpGrants: readonly { readonly pluginId: string; readonly mcpServerId: string }[];
}

export interface ReachSystem {
  /** `plugin:<id>` or `mcp:<server id>`. */
  readonly key: string;
  readonly type: 'plugin' | 'mcp_server';
  /** The plugin id or MCP server id. */
  readonly ref: string;
  readonly name: string;
  readonly read: boolean;
  readonly write: boolean;
  /** `false` when read/write had to be assumed (nothing declared). */
  readonly declared: boolean;
  /** How the agent reaches it: `grant`, or the plugin ids it holds that do. */
  readonly via: readonly string[];
}

export interface AgentReach {
  readonly systems: readonly ReachSystem[];
  /** All connected systems of the instance. */
  readonly connectedSystems: number;
  /** The reach covers every connected system (and there is at least one). */
  readonly coversEverySystem: boolean;
  /** Covers every connected system, and there are at least two. */
  readonly broad: boolean;
}

/** The manifest capabilities' declared `side_effects`, unknown values left out. */
export function declaredSideEffects(manifest: unknown): SideEffect[] {
  if (!isRecord(manifest) || !Array.isArray(manifest['capabilities'])) return [];
  return manifest['capabilities']
    .map((cap) => (isRecord(cap) ? cap['side_effects'] : undefined))
    .filter((v): v is SideEffect => typeof v === 'string' && SIDE_EFFECTS.has(v));
}

/** The tools of an MCP server's `discovered_tools`, unusable entries left out. */
export function discoveredMcpTools(discovered: readonly unknown[]): ReachMcpTool[] {
  return discovered.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool['name'] !== 'string') return [];
    // `McpManager.listTools` persists the hint flat (`readOnlyHint: true`);
    // the raw `annotations` form is read too for rows written elsewhere.
    const annotations = tool['annotations'];
    const hint =
      tool['readOnlyHint'] === true
        ? true
        : isRecord(annotations)
          ? annotations['readOnlyHint']
          : undefined;
    return [{ name: tool['name'], readOnly: typeof hint === 'boolean' ? hint : undefined }];
  });
}

export function computeAgentReach(env: ReachEnvironment, grants: ReachGrants): AgentReach {
  const held = new Set(grants.plugins.filter((p) => p.enabled).map((p) => p.pluginId));
  const systems = [
    ...pluginSystems(env.plugins, held),
    ...mcpSystems(env.mcpServers, grants, held),
  ];
  const connectedSystems = env.plugins.length + env.mcpServers.length;
  const coversEverySystem = connectedSystems > 0 && systems.length === connectedSystems;
  return {
    systems,
    connectedSystems,
    coversEverySystem,
    broad: coversEverySystem && connectedSystems >= MIN_BROAD_REACH_SYSTEMS,
  };
}

/** A change that makes an agent's reach broad needs the operator's confirmation. */
export function requiresBroadReachConfirmation(before: AgentReach, after: AgentReach): boolean {
  return after.broad && !before.broad;
}

function pluginSystems(plugins: readonly ReachPlugin[], held: ReadonlySet<string>): ReachSystem[] {
  return plugins
    .filter((p) => held.has(p.id))
    .map((p) => {
      const declared = p.sideEffects.length > 0;
      return {
        key: `plugin:${p.id}`,
        type: 'plugin' as const,
        ref: p.id,
        name: p.name,
        read: declared ? p.sideEffects.includes('read') : true,
        write: declared ? p.sideEffects.includes('write') : true,
        declared,
        via: ['grant'],
      };
    })
    .sort(byName);
}

function mcpSystems(
  servers: readonly ReachMcpServer[],
  grants: ReachGrants,
  held: ReadonlySet<string>,
): ReachSystem[] {
  return servers
    .flatMap((server) => {
      const toolNames = new Set(
        grants.mcpToolGrants.filter((g) => g.mcpServerId === server.id).map((g) => g.toolName),
      );
      const viaPlugins = [
        ...new Set(
          grants.pluginMcpGrants
            .filter((g) => g.mcpServerId === server.id && held.has(g.pluginId))
            .map((g) => g.pluginId),
        ),
      ].sort();
      if (toolNames.size === 0 && viaPlugins.length === 0) return [];
      // A plugin holding the server may call any of its tools.
      const access =
        viaPlugins.length > 0 ? wholeServerAccess(server) : toolAccess(server, toolNames);
      return [
        {
          key: `mcp:${server.id}`,
          type: 'mcp_server' as const,
          ref: server.id,
          name: server.name,
          ...access,
          via: [...(toolNames.size > 0 ? ['grant'] : []), ...viaPlugins],
        },
      ];
    })
    .sort(byName);
}

type Access = Pick<ReachSystem, 'read' | 'write' | 'declared'>;

function wholeServerAccess(server: ReachMcpServer): Access {
  if (server.tools.length === 0) return { read: true, write: true, declared: false };
  return accessOf(server.tools.map((t) => t.readOnly));
}

function toolAccess(server: ReachMcpServer, toolNames: ReadonlySet<string>): Access {
  const byName = new Map(server.tools.map((t) => [t.name, t]));
  const known = [...toolNames].map((name) => byName.get(name));
  const access = accessOf(known.map((t) => t?.readOnly));
  // A granted tool the last discovery does not know may do anything.
  if (known.some((t) => t === undefined)) return { read: true, write: true, declared: false };
  return access;
}

function accessOf(readOnly: readonly (boolean | undefined)[]): Access {
  return {
    read: readOnly.some((r) => r === true),
    write: readOnly.some((r) => r !== true),
    declared: readOnly.every((r) => r !== undefined),
  };
}

function byName(a: ReachSystem, b: ReachSystem): number {
  return a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
