// Kernel-guarded uninstall of an archetype plugin (#2088, spec 2042 §5.10).
//
// Before an archetype plugin is unloaded, the kernel itself takes every agent
// of its archetype out of service, independently of the plugin's own
// `onUninstall` (whose failure is caught and would otherwise leave the
// agents running without the plugin that defines them):
//
//   - each enabled agent goes through the end-of-service procedure
//     (`agentEndOfService.ts`) with the reason "archetype plugin removed",
//     while the plugin is still installed, so it can close its processes;
//   - the agent is then DISABLED. Its record, identity and settings stay;
//     it is never converted to another archetype and never deleted.
//
// What the plugin stored (its process tables) keeps its last state for the
// operator; the kernel does not touch it.

import { archetypeOf } from '@omadia/orchestrator';

import { systemAuditActor, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { AgentEndOfService, EndOfServiceAgent, EndOfServiceReport } from './agentEndOfService.js';
import { installedArchetypePlugins, type ArchetypePluginSources } from './archetypeRegistrySync.js';

export interface ArchetypeUninstallAgent extends EndOfServiceAgent {
  readonly status: string;
}

export interface ArchetypeUninstallGuardDeps {
  readonly sources: () => ArchetypePluginSources;
  /** Live agents, and the switch that disables one. Absent = no config store. */
  readonly agents: () =>
    | {
        list(): Promise<readonly ArchetypeUninstallAgent[]>;
        disable(agentId: string): Promise<void>;
      }
    | undefined;
  readonly endOfService: AgentEndOfService;
  readonly audit?: (entry: AuditEntryInput) => Promise<void>;
  /** After the agents changed: rebuild the registry. */
  readonly reload?: () => Promise<unknown>;
  readonly log?: (message: string) => void;
}

export interface ArchetypeUninstallOutcome {
  readonly archetypeId: string;
  readonly agents: readonly { readonly slug: string; readonly disabled: boolean; readonly report: EndOfServiceReport }[];
}

const ACTOR = systemAuditActor('system:archetype-plugin-uninstall');

/**
 * Take the agents of `pluginId`'s archetype out of service. `undefined` when
 * the plugin is not an installed archetype plugin (nothing to guard). Never
 * throws: the uninstall goes on, and what could not be done is logged.
 */
export async function guardArchetypePluginUninstall(
  pluginId: string,
  deps: ArchetypeUninstallGuardDeps,
): Promise<ArchetypeUninstallOutcome | undefined> {
  const log = deps.log ?? (() => undefined);
  const plugin = installedArchetypePlugins(deps.sources()).find((p) => p.pluginId === pluginId);
  if (!plugin) return undefined;
  const archetypeId = plugin.archetype.id;
  const store = deps.agents();
  if (!store) {
    log(`[archetypes] '${pluginId}' is being removed and no agent store is available: agents of '${archetypeId}' were not disabled`);
    return { archetypeId, agents: [] };
  }
  const outcome: { slug: string; disabled: boolean; report: EndOfServiceReport }[] = [];
  let agents: readonly ArchetypeUninstallAgent[] = [];
  try {
    agents = (await store.list()).filter((agent) => archetypeOf(agent) === archetypeId && agent.status === 'enabled');
  } catch (err) {
    log(`[archetypes] listing the agents of '${archetypeId}' failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const agent of agents) {
    const report = await deps.endOfService.run(agent, 'archetype_plugin_removed', ACTOR);
    let disabled = false;
    try {
      await store.disable(agent.id);
      disabled = true;
      await deps.audit?.({
        actor: ACTOR,
        action: 'agent.disable',
        target: `agent:${agent.id}`,
        before: { status: 'enabled' },
        after: { status: 'disabled', slug: agent.slug, archetype: archetypeId, reason: 'archetype_plugin_removed', plugin: pluginId },
      });
    } catch (err) {
      log(`[archetypes] disabling '${agent.slug}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    outcome.push({ slug: agent.slug, disabled, report });
  }
  if (outcome.length > 0) {
    log(
      `[archetypes] '${pluginId}' is being removed: ${String(outcome.filter((a) => a.disabled).length)} of ${String(outcome.length)} agents of '${archetypeId}' disabled, their records kept`,
    );
    try {
      await deps.reload?.();
    } catch (err) {
      log(`[archetypes] registry reload after disabling failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { archetypeId, agents: outcome };
}
