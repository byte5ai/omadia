import {
  PRIVACY_BYPASS_SCOPES_CONFIG_KEY,
  PRIVACY_MODE_CONFIG_KEY,
  resolveEffectivePrivacyMode,
} from '@omadia/plugin-api';

/**
 * Slice 2.5 — which plugin's operator setting decides whether a tool result
 * bypasses the Privacy Shield. Pure; the orchestrator wires it in
 * `buildPrivacyHandle`. Lookup order:
 *
 *   0. a tool of an MCP server the operator flagged `privacyBypass`
 *   1. a kernel tool registered with its plugin's `(agentId, readConfig)`
 *   2. a domain tool (sub-agent delegation wrapper) with its agent id
 *   3. a sub-agent's INNER tool — the toolkit tools the agent's sub-agent
 *      runs, which an integration plugin may contribute — decided by the
 *      sub-agent's OWNING agent, so one setting on an agent covers its
 *      sub-agent (`turnContext.subAgentOwnerPluginId`)
 *
 * A tool that already has an owner is decided by that owner alone and never
 * falls through to path 3: an ownerless kernel registration (memory,
 * `query_dataset`, …) always stays guarded, and another agent's domain tool
 * follows that agent's setting. Before this rule, a sub-agent owner set to
 * `bypass`, or with a `per_tool` list naming such a tool, unmasked results
 * whose owner never opted out (#1507 security review).
 *
 * `OMADIA_PRIVACY_FORCE_GUARDED` is honoured inside
 * `resolveEffectivePrivacyMode` for every path.
 */
export interface PrivacyBypassResolverDeps {
  /** Path 0 — `isMcpServerBypassInForce` for this tool. */
  readonly mcpBypassInForce: (toolName: string) => { pluginId: string } | undefined;
  readonly nativeTool: (
    toolName: string,
  ) =>
    | {
        readonly agentId?: string;
        readonly readConfig?: (key: string) => unknown | undefined;
      }
    | undefined;
  readonly domainToolAgentId: (toolName: string) => string | undefined;
  /** True when `toolName` is a domain tool at all (with or without agent id). */
  readonly isDomainTool: (toolName: string) => boolean;
  readonly pluginConfigGet:
    | ((agentId: string, configKey: string) => unknown | undefined)
    | undefined;
  readonly subAgentOwner: () => string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export function createPrivacyBypassResolver(
  deps: PrivacyBypassResolverDeps,
): (toolName: string) => { pluginId: string } | undefined {
  const decide = (
    pluginId: string,
    toolName: string,
    read: (key: string) => unknown | undefined,
  ): { pluginId: string } | undefined =>
    resolveEffectivePrivacyMode({
      storedMode: read(PRIVACY_MODE_CONFIG_KEY),
      storedScopes: read(PRIVACY_BYPASS_SCOPES_CONFIG_KEY),
      toolName,
      env: deps.env,
    }) === 'bypass'
      ? { pluginId }
      : undefined;

  const byAgentId = (
    agentId: string,
    toolName: string,
  ): { pluginId: string } | undefined => {
    const get = deps.pluginConfigGet;
    if (get === undefined) return undefined;
    return decide(agentId, toolName, (key) => get(agentId, key));
  };

  return (toolName) => {
    const mcp = deps.mcpBypassInForce(toolName);
    if (mcp) return mcp;
    // Path 1 — a kernel registration is authoritative for its tool. With an
    // owner it follows the owner's setting; without one it is a kernel
    // meta-tool and stays guarded.
    const reg = deps.nativeTool(toolName);
    if (reg !== undefined) {
      if (reg.agentId !== undefined && reg.readConfig !== undefined) {
        return decide(reg.agentId, toolName, reg.readConfig);
      }
      return undefined;
    }
    // Path 2 — a domain tool follows its own agent's setting only.
    if (deps.isDomainTool(toolName)) {
      const agentId = deps.domainToolAgentId(toolName);
      return agentId !== undefined ? byAgentId(agentId, toolName) : undefined;
    }
    // Path 3 — a sub-agent's toolkit tool.
    const owner = deps.subAgentOwner();
    return owner !== undefined ? byAgentId(owner, toolName) : undefined;
  };
}
