// Archetype plugins and the archetype registry (#2088, spec 2042 §5.10).
//
// An installed plugin of kind `archetype` REGISTERS the archetype its manifest
// describes: the kernel enforces that descriptor for every agent of the
// archetype, and `agent_archetypes.source` names the plugin. This module is
// the one place that brings the two registries (the process's descriptors,
// the database's rows) in line with what is installed. It runs at boot and
// after every install, uninstall and grant.
//
// INSTALLED, NOT ACTIVE. A descriptor says what agents of the archetype must
// never get, and that holds while the plugin is stopped or broken as well, so
// an installed plugin registers its archetype whatever its status. Only an
// uninstall takes the descriptor away. For `facilitator` the kernel's seed
// then comes back (it stays the fallback while engine plugins without a
// descriptor of their own are supported); any other archetype is left without
// a descriptor, and its agents omit everything.
//
// TWO PLUGINS, ONE ARCHETYPE is not "the first wins": an agent with two
// descriptors has no defined contract. Neither is registered, the previous
// state stays, and the log says which plugins to remove.

import {
  getArchetype,
  registerArchetype,
  type ArchetypeDescriptor,
} from '@omadia/orchestrator';

import type { PluginArchetype } from '../api/admin-v1.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';

export interface ArchetypePluginSources {
  readonly installedRegistry: Pick<InstalledRegistry, 'list'> | undefined;
  readonly catalog: Pick<PluginCatalog, 'get'> | undefined;
}

export interface InstalledArchetypePlugin {
  readonly pluginId: string;
  readonly status: string;
  readonly archetype: PluginArchetype;
}

/** Installed plugins of kind `archetype`, by plugin id. */
export function installedArchetypePlugins(sources: ArchetypePluginSources): InstalledArchetypePlugin[] {
  const { installedRegistry, catalog } = sources;
  if (!installedRegistry || !catalog) return [];
  const out: InstalledArchetypePlugin[] = [];
  for (const entry of installedRegistry.list()) {
    const plugin = catalog.get(entry.id)?.plugin;
    if (plugin?.kind !== 'archetype' || !plugin.archetype) continue;
    out.push({ pluginId: entry.id, status: entry.status, archetype: plugin.archetype });
  }
  return out.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

/** The installed plugin that delivers `archetypeId`, when exactly one does. */
export function archetypePluginFor(
  sources: ArchetypePluginSources,
  archetypeId: string,
): InstalledArchetypePlugin | undefined {
  const matching = installedArchetypePlugins(sources).filter((p) => p.archetype.id === archetypeId);
  return matching.length === 1 ? matching[0] : undefined;
}

function toDescriptor(plugin: InstalledArchetypePlugin): ArchetypeDescriptor {
  const a = plugin.archetype;
  return {
    id: a.id,
    source: plugin.pluginId,
    omits: a.omits as ArchetypeDescriptor['omits'],
    adds: a.adds as NonNullable<ArchetypeDescriptor['adds']>,
    requires: a.requires as NonNullable<ArchetypeDescriptor['requires']>,
    noun: a.noun,
    ...(a.label !== undefined ? { label: a.label } : {}),
    ...(a.labelPlural !== undefined ? { labelPlural: a.labelPlural } : {}),
    ...(a.description !== undefined ? { description: a.description } : {}),
    ...(a.omissionReasons ? { omissionReasons: a.omissionReasons } : {}),
    ...(a.roleContract !== undefined ? { roleContract: a.roleContract } : {}),
  };
}

/** What the database side needs; a `pg.Pool` satisfies it. */
export interface ArchetypeRowStore {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

export interface ArchetypeRegistrySync {
  /** Bring descriptors and rows in line with what is installed. Never throws. */
  sync(): Promise<{ registered: string[]; removed: string[]; conflicts: string[] }>;
}

export function createArchetypeRegistrySync(deps: {
  readonly sources: () => ArchetypePluginSources;
  /** Absent = no database (in-memory backend): descriptors only. */
  readonly rows?: () => ArchetypeRowStore | undefined;
  readonly log?: (message: string) => void;
}): ArchetypeRegistrySync {
  const log = deps.log ?? (() => undefined);
  /** archetype id → what this sync registered for it. */
  const held = new Map<string, { pluginId: string; signature: string; dispose: () => void }>();

  return {
    async sync() {
      const registered: string[] = [];
      const removed: string[] = [];
      const conflicts: string[] = [];
      const byArchetype = new Map<string, InstalledArchetypePlugin[]>();
      for (const plugin of installedArchetypePlugins(deps.sources())) {
        byArchetype.set(plugin.archetype.id, [...(byArchetype.get(plugin.archetype.id) ?? []), plugin]);
      }

      // Gone: no plugin delivers the archetype any more.
      for (const [archetypeId, entry] of held) {
        if (byArchetype.has(archetypeId)) continue;
        entry.dispose();
        held.delete(archetypeId);
        removed.push(archetypeId);
        const fallback = getArchetype(archetypeId);
        log(
          `[archetypes] '${archetypeId}' is no longer delivered by '${entry.pluginId}': ${
            fallback ? `the kernel's own descriptor applies again` : 'its agents omit everything until a plugin delivers it again'
          }`,
        );
        if (fallback) await setSource(archetypeId, fallback.source);
      }

      for (const [archetypeId, plugins] of byArchetype) {
        if (plugins.length > 1) {
          conflicts.push(archetypeId);
          log(
            `[archetypes] more than one installed plugin delivers the archetype '${archetypeId}' (${plugins
              .map((p) => p.pluginId)
              .join(', ')}); none of them is registered until all but one are removed`,
          );
          continue;
        }
        const plugin = plugins[0]!;
        const signature = JSON.stringify(plugin.archetype);
        const current = held.get(archetypeId);
        if (current && current.pluginId === plugin.pluginId && current.signature === signature) continue;
        try {
          current?.dispose();
          const dispose = registerArchetype(toDescriptor(plugin));
          held.set(archetypeId, { pluginId: plugin.pluginId, signature, dispose });
          registered.push(archetypeId);
          log(`[archetypes] '${archetypeId}' registered by '${plugin.pluginId}'`);
        } catch (err) {
          held.delete(archetypeId);
          log(
            `[archetypes] descriptor of '${plugin.pluginId}' for '${archetypeId}' refused: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        await setSource(archetypeId, plugin.pluginId);
      }
      return { registered, removed, conflicts };
    },
  };

  /** The row an agent's `archetype` references, with who delivers it. A
   *  failure is logged: the descriptor in the process is what is enforced. */
  async function setSource(archetypeId: string, source: string): Promise<void> {
    const rows = deps.rows?.();
    if (!rows) return;
    try {
      await rows.query(
        `INSERT INTO agent_archetypes (id, source) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source`,
        [archetypeId, source],
      );
    } catch (err) {
      log(
        `[archetypes] could not record '${archetypeId}' (source '${source}') in agent_archetypes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
