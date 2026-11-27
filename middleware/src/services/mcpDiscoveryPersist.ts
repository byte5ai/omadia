/**
 * #1917 — store what a Discover or re-scan found, the one way both do it.
 *
 * Every listed tool is scanned and its verdict persisted BEFORE the tool list
 * itself is stored (scan gate, #454), verdicts of tools that are gone are
 * pruned (acknowledgements stay, see `pruneMcpToolVerdicts`), then the list is
 * stored.
 *
 * A server that listed tools before and now lists none is far more often a
 * server mid-restart than one that dropped its whole surface. That list is not
 * stored and nothing is pruned: the previous tools stay, and the dispatch
 * guard still checks every call. The caller reports the skip.
 */

import type { AgentGraphStore, McpServerRow, McpToolDescriptor } from '@omadia/orchestrator';

import { scanDiscoveredTools } from './mcpToolGuard.js';

export interface DiscoveryPersistOutcome {
  /** The empty list was not stored (the server listed tools before). */
  readonly emptyListIgnored: boolean;
  /** Verdicts written. */
  readonly scanned: number;
}

export async function persistDiscoveredTools(
  graph: Pick<AgentGraphStore, 'upsertMcpToolVerdict' | 'pruneMcpToolVerdicts' | 'setMcpDiscoveredTools'>,
  server: Pick<McpServerRow, 'id' | 'discoveredTools'>,
  tools: readonly McpToolDescriptor[],
): Promise<DiscoveryPersistOutcome> {
  if (tools.length === 0 && (server.discoveredTools?.length ?? 0) > 0) {
    return { emptyListIgnored: true, scanned: 0 };
  }
  const verdicts = scanDiscoveredTools(server.id, tools);
  for (const verdict of verdicts) {
    await graph.upsertMcpToolVerdict(verdict);
  }
  await graph.pruneMcpToolVerdicts(
    server.id,
    tools.map((t) => t.name),
  );
  await graph.setMcpDiscoveredTools(server.id, tools);
  return { emptyListIgnored: false, scanned: verdicts.length };
}
