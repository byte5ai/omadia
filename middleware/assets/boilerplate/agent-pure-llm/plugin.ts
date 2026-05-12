import type { PluginContext } from './types.js';

export const AGENT_ID = '{{AGENT_ID}}' as const;

/**
 * Pure-LLM Agent runtime contract.
 *
 * No external API client, no API token / base URL, no setup-secrets — the
 * agent is pure prompting. The orchestrator forwards user messages
 * together with the system prompt assembled from `skills/` partials and
 * returns the LLM response. `toolkit.tools` is empty; the runtime sees
 * that and skips the tool-loop entirely.
 *
 *   - activate(ctx) has a 10s budget; trivial in the pure-LLM case
 *                   (no self-test of an API endpoint required).
 *   - close()       has a 5s budget; without connections / watches a no-op.
 *
 * Move to the `agent-integration` template instead the moment you need
 * an external API call — adding a client.ts + toolkit.ts piecemeal here
 * loses the integrity guarantees of that template.
 */
export interface AgentHandle {
  readonly toolkit: { tools: never[]; close(): Promise<void> };
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<AgentHandle> {
  // #region builder:activate-body
  ctx.log('activating');

  const toolkit = {
    tools: [] as never[],
    async close(): Promise<void> {},
  };

  return {
    toolkit,
    async close() {
      ctx.log('deactivating');
      await toolkit.close();
    },
  };
  // #endregion
}

export default { AGENT_ID, activate };
