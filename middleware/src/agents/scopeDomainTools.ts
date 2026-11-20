/**
 * Per-Agent domain-tool isolation.
 *
 * The kernel collects every sub-agent query tool (`query_odoo_accounting`,
 * `query_confluence_playbook`, the X agent's tool, Builder-uploaded agents,
 * …) into a single `DomainTool[]` and hydrates the multi-orchestrator
 * registry's per-Agent orchestrators with them. Hydrating EVERY Agent with
 * the full set leaks capability: a scoped Agent (e.g. "marketing", which
 * only enables the X plugin) could call `query_odoo_accounting` and reach
 * Odoo — a connector it was never granted.
 *
 * A `DomainTool` carries `agentId` — the manifest id of the agent-plugin
 * that exposes it (set by `createDomainTool` / `dynamicAgentRuntime`),
 * e.g. `query_odoo_accounting` → `de.byte5.agent.odoo-accounting`. An Agent
 * may use a tool only when that backing plugin is ENABLED on it. A tool
 * with no `agentId` is a core helper (memory, ask_user_choice, …) available
 * to everyone.
 *
 * No Agent holds a plugin it was not explicitly granted (#2054, INV-8) —
 * the fallback Agent included, which used to receive every installed plugin.
 */

import type { DomainTool } from '@omadia/orchestrator';

/** Minimal shape of an Agent's plugin row needed for scoping. */
export interface AgentPluginScope {
  readonly pluginId: string;
  readonly enabled: boolean;
}

/**
 * Return the subset of `tools` an Agent with the given plugin rows may use.
 *
 * - `agentId === undefined` → core helper, always included.
 * - `agentId` ∈ the Agent's enabled plugin ids → included.
 * - otherwise → withheld.
 */
export function scopeDomainToolsToPlugins(
  tools: readonly DomainTool[],
  plugins: readonly AgentPluginScope[],
): DomainTool[] {
  const enabled = new Set(
    plugins.filter((p) => p.enabled).map((p) => p.pluginId),
  );
  return tools.filter(
    (t) => t.agentId === undefined || enabled.has(t.agentId),
  );
}
