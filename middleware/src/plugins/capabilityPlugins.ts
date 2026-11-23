import { CAPABILITY_PLUGIN_KINDS, type Plugin } from '../api/admin-v1.js';
import type { PluginCatalog } from './manifestLoader.js';

/** The agent runtime's own plugin id: the runtime, never a grant. */
export const AGENT_RUNTIME_PLUGIN_ID = '@omadia/orchestrator';

/**
 * #2054 — the one answer to "is this plugin a capability plugin?" (spec 2042
 * §5.10, INV-8).
 *
 * A capability plugin delivers capabilities an operator grants to agents one
 * by one: kinds `integration`, `tool` and `skill`. Installing it grants it to
 * no agent; the install flow only OFFERS it to agents the operator picks.
 * Every other plugin (channel, model, archetype, system module, template) is
 * never granted to an agent and never offered.
 *
 * Kind `agent` is retired (its plugins became capability plugins with agent
 * templates, §5.2). The kernel runs no such plugin, so it delivers nothing to
 * grant and is not a capability.
 *
 * Never a capability, whatever the manifest says:
 *  - the agent runtime itself (`@omadia/orchestrator`), which IS the agent;
 *  - reference-only plugins (`is_reference_only`, the Plugin Builder's pattern
 *    source), which never run as part of an agent.
 */

export function isCapabilityPlugin(
  plugin: Pick<Plugin, 'id' | 'kind' | 'is_reference_only'> | undefined,
): boolean {
  if (!plugin) return false;
  if (plugin.id === AGENT_RUNTIME_PLUGIN_ID) return false;
  if (plugin.is_reference_only === true) return false;
  return CAPABILITY_PLUGIN_KINDS.has(plugin.kind);
}

/**
 * The ids of `pluginIds` that are capability plugins in `catalog`. An id the
 * catalog does not know is left out: nothing is offered that cannot be
 * classified.
 */
export function capabilityPluginIds(
  pluginIds: readonly string[],
  catalog: Pick<PluginCatalog, 'get'>,
): string[] {
  return pluginIds.filter((id) => isCapabilityPlugin(catalog.get(id)?.plugin));
}
