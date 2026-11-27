/**
 * W2-1 (#544) — the MCP `input_required` replayer, out of `index.ts` so it can
 * be tested (#1932).
 *
 * A replay is a fresh `tools/call`, so it needs the server's live config
 * (endpoint, headers, Vault-resolved env) re-resolved rather than a snapshot
 * taken when the call was parked. #1932 — that config comes from
 * `mcpRowToConfig`, the same row → config mapping every other call path uses:
 * non-secret endpoint placeholders filled, static headers set. A hand-built
 * config dropped both, and a replay that found the pooled connection evicted
 * reconnected without them.
 *
 * A server the operator deleted between the two turns returns `undefined`,
 * which the orchestrator surfaces as "no longer reachable".
 */

import {
  planMcpInputReplay,
  type McpInputReplayer,
  type McpManager,
  type McpServerRow,
} from '@omadia/orchestrator';

import { mcpRowToConfig } from '../agents/subAgentToolHydration.js';

export function createMcpInputReplayer(deps: {
  readonly listServers: () => Promise<readonly McpServerRow[]>;
  readonly manager: Pick<McpManager, 'callTool'>;
}): McpInputReplayer {
  return {
    replay: async (record, inputResponses) => {
      const server = (await deps.listServers()).find((s) => s.id === record.serverId);
      if (!server) return undefined;
      // #562 phase 3 — the RECORD decides which dialect the retry speaks; see
      // `planMcpInputReplay`.
      const plan = planMcpInputReplay(record, inputResponses);
      return deps.manager.callTool(mcpRowToConfig(server), record.toolName, plan.args, plan.replay);
    },
  };
}
