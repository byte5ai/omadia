/**
 * Bulk / periodic MCP re-scan (epic #459 W6, issue #463; #455 Phase 3).
 *
 * Re-runs discovery + the #454 scan for every enabled server, so post-import
 * drift (a tool whose description turned hostile since the last discover)
 * surfaces WITHOUT operator action — the credible mitigation the Invariant
 * Labs writeup calls for beyond one-time scans. Also closes the documented
 * pre-0008 residual gap: after one full pass, every reachable tool has a
 * current verdict and the fail-closed dispatch guard applies everywhere.
 *
 * Per-server failures degrade gracefully (a dead server must not abort the
 * sweep); the policy refresh + epoch bumps run once at the end.
 */
import { mcpRowToConfig } from '../agents/subAgentToolHydration.js';
import { refreshMcpGrantPolicy } from './mcpGrantPolicy.js';
import { persistDiscoveredTools } from './mcpDiscoveryPersist.js';

import type { AgentGraphStore, McpManager } from '@omadia/orchestrator';

export interface McpRescanResult {
  readonly scannedServers: number;
  readonly scannedTools: number;
  readonly failures: readonly { serverId: string; serverName: string; error: string }[];
}

export async function rescanAllMcpServers(
  graph: AgentGraphStore,
  manager: Pick<McpManager, 'listTools'>,
  log?: (msg: string) => void,
): Promise<McpRescanResult> {
  const servers = await graph.listMcpServers();
  const failures: { serverId: string; serverName: string; error: string }[] = [];
  let scannedServers = 0;
  let scannedTools = 0;
  for (const server of servers) {
    if (server.status !== 'enabled') continue;
    try {
      // #545 — the security rescan bypasses the tool-list cache: re-scanning
      // a cached list would re-scan what was already scanned.
      const tools = await manager.listTools(mcpRowToConfig(server), { fresh: true });
      // Scan, prune verdicts of vanished tools, store (#1917: an empty list
      // after a non-empty one is not stored — see `persistDiscoveredTools`).
      const persisted = await persistDiscoveredTools(graph, server, tools);
      if (persisted.emptyListIgnored) {
        failures.push({
          serverId: server.id,
          serverName: server.name,
          error: 'the server listed no tools; the previous tool list was kept',
        });
        log?.(`[mcpRescan] server "${server.name}" listed no tools — previous list kept`);
        continue;
      }
      // Signature-relevant epochs: rebuilds pick up spec/verdict changes for
      // both grant-holding and binding-only agents.
      await graph.bumpMcpGrantEpoch(server.id);
      await graph.bumpSkillBindingEpoch(server.id);
      scannedServers += 1;
      scannedTools += persisted.scanned;
    } catch (err) {
      failures.push({ serverId: server.id, serverName: server.name, error: String(err) });
      log?.(`[mcpRescan] server "${server.name}" failed: ${String(err)}`);
    }
  }
  await refreshMcpGrantPolicy(graph);
  log?.(
    `[mcpRescan] ${String(scannedServers)} server(s), ${String(scannedTools)} tool verdict(s), ${String(failures.length)} failure(s)`,
  );
  return { scannedServers, scannedTools, failures };
}
