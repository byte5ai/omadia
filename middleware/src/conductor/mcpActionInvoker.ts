// Conductor action step → MCP tool call.
//
// Runs in the OPERATOR trust class, exactly like the admin Control Center's
// test-call route: a Conductor workflow is operator-authored and its routes
// share the MCP admin router's auth gate, so a workflow calling an enabled
// server's tool is the operator calling it. There is no acting end-user in a
// run, hence only `service`-delegation servers are callable — `per_user` (and
// anything unknown) fails closed. Results are plain text in the run context,
// as with every other action step.

import type { McpServerConfig, McpServerRow } from '@omadia/orchestrator';

import { parseMcpActionId } from './mcpActionId.js';

/** The one McpManager method we depend on. */
export interface McpCallSurface {
  callTool(cfg: McpServerConfig, toolName: string, args: Record<string, unknown>): Promise<string>;
}

export interface McpActionInvokerDeps {
  /** Resolved per call — a disabled/removed server must bite immediately. */
  listServers: () => Promise<readonly McpServerRow[]>;
  /** undefined when MCP is not wired on this host. */
  getMcp: () => McpCallSurface | undefined;
  /** Row → connect config (the kernel passes `mcpRowToConfig`; injected so this module stays free of the hydration import graph). */
  toConfig: (row: McpServerRow) => McpServerConfig;
  /**
   * The SAME scan-verdict / disabled-server gate the orchestrator dispatch runs
   * (`mcpDispatchDenial`): a denial string blocks the call. Fail-closed on
   * unscanned pairs and unacknowledged high-risk verdicts — Conductor must not
   * be the one caller that skips the Control Center's policy.
   */
  dispatchDenial: (serverId: string, toolName: string) => string | null;
  log?: (msg: string) => void;
}

/** A tool-call failure the MCP client reports as text rather than a rejection. */
const MCP_ERROR_PREFIX = 'Error:';

export function createMcpActionInvoker(deps: McpActionInvokerDeps): (actionId: string, input: unknown) => Promise<string> {
  return async (actionId, input) => {
    const ref = parseMcpActionId(actionId);
    if (!ref) throw new Error(`'${actionId}' is not an mcp action id`);
    const mcp = deps.getMcp();
    if (!mcp) throw new Error(`action '${actionId}': mcp is not wired on this host`);

    const server = (await deps.listServers()).find((s) => s.id === ref.serverId);
    if (!server) throw new Error(`action '${actionId}': mcp server not found`);
    if (server.status !== 'enabled') throw new Error(`action '${actionId}': mcp server disabled`);
    // Allowlist, not denylist: a missing/unknown delegation value must not be callable.
    if (server.delegation !== 'service') {
      throw new Error(`action '${actionId}': mcp server requires service delegation (a Conductor run has no acting user)`);
    }

    const denial = deps.dispatchDenial(server.id, ref.toolName);
    if (denial) throw new Error(`action '${actionId}': ${denial}`);

    const args = isRecord(input) ? input : {};
    deps.log?.(`[conductor] mcp action → server '${server.name}' (${server.id}) tool '${ref.toolName}'`);
    const result = await mcp.callTool(deps.toConfig(server), ref.toolName, args);
    // The MCP client folds tool failures into an "Error: …" string (the admin
    // test-call route keys on the same prefix). A failed call must fail the
    // step rather than being stored as its successful result.
    if (result.startsWith(MCP_ERROR_PREFIX)) {
      throw new Error(`action '${actionId}': ${result}`);
    }
    return result;
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Action ids for every CALLABLE MCP server's discovered tools — enabled AND
 * service-delegated, the same gate the invoker applies, so the builder's
 * missing-capability signal and the runtime can never disagree (a `per_user`
 * tool is reported missing rather than failing at run time). Defensive over
 * `discoveredTools: unknown[]` — only entries with a non-empty string `name`
 * count. Sorted for stable catalogs.
 */
export function mcpActionIds(
  servers: readonly McpServerRow[],
  dispatchDenial: (serverId: string, toolName: string) => string | null = () => null,
): string[] {
  const out: string[] = [];
  for (const server of servers) {
    if (server.status !== 'enabled' || server.delegation !== 'service') continue;
    for (const tool of server.discoveredTools) {
      const name = isRecord(tool) && typeof tool.name === 'string' ? tool.name.trim() : '';
      if (name.length === 0) continue;
      // Catalog == what the invoker would run: a verdict-blocked or unscanned tool is reported
      // missing by the builder instead of failing at run time.
      if (dispatchDenial(server.id, name) !== null) continue;
      out.push(`mcp:${server.id}:${name}`);
    }
  }
  return out.sort();
}
