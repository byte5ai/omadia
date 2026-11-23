// GET /api/v1/operator/archetypes (#2088) — the archetypes agents can be
// created of on this instance, for the agent directory: one section per
// archetype instead of a hard-coded one.
//
// The answer is the descriptor the kernel enforces, plus who delivers it.
// Texts of a descriptor are given as the manifest states them (a string or an
// `{ en, de }` map); the web-ui picks the language. `standard` is included:
// it is an archetype like the others, built in.

import { Router, type Request, type Response } from 'express';

import { listArchetypes, STANDARD_ARCHETYPE, type ArchetypeDescriptor } from '@omadia/orchestrator';

import {
  archetypeSettingFields,
  type ArchetypeSettingFieldDto,
} from './operatorAgentArchetypeSettings.js';
import {
  installedArchetypePlugins,
  type ArchetypePluginSources,
} from '../platform/archetypeRegistrySync.js';

export interface OperatorArchetypeDto {
  readonly id: string;
  /** `'kernel'` (built in, or the kernel's own descriptor) or a plugin id. */
  readonly source: string;
  readonly built_in: boolean;
  readonly label: ArchetypeDescriptor['label'] | null;
  readonly label_plural: ArchetypeDescriptor['labelPlural'] | null;
  readonly description: ArchetypeDescriptor['description'] | null;
  readonly omits: readonly string[];
  readonly adds: readonly string[];
  readonly requires: readonly string[];
  /** The installed archetype plugin that delivers it, when one does. */
  readonly plugin: { readonly id: string; readonly status: string } | null;
  /** Number of agents of this archetype; `null` without a config store. */
  readonly agent_count: number | null;
  /** #2066 — the per-agent settings the archetype declares; `[]` = none. */
  readonly agent_settings: readonly ArchetypeSettingFieldDto[];
}

export interface OperatorArchetypesDeps {
  readonly sources: () => ArchetypePluginSources;
  /** Agents with their archetype, for the counts. Absent = counts are `null`. */
  readonly listAgentArchetypes?: () => Promise<readonly string[] | undefined>;
}

export function buildOperatorArchetypes(
  descriptors: readonly ArchetypeDescriptor[],
  plugins: ReturnType<typeof installedArchetypePlugins>,
  agentArchetypes: readonly string[] | undefined,
): OperatorArchetypeDto[] {
  const rank = (id: string): number => (id === STANDARD_ARCHETYPE ? 0 : 1);
  return [...descriptors]
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
    .map((descriptor) => {
      const delivering = plugins.filter((p) => p.archetype.id === descriptor.id);
      // Only the plugin whose descriptor is the one in force is named.
      const plugin = delivering.find((p) => p.pluginId === descriptor.source);
      return {
        id: descriptor.id,
        source: descriptor.source,
        built_in: descriptor.id === STANDARD_ARCHETYPE,
        label: descriptor.label ?? null,
        label_plural: descriptor.labelPlural ?? null,
        description: descriptor.description ?? null,
        omits: [...descriptor.omits],
        adds: [...(descriptor.adds ?? [])],
        requires: [...(descriptor.requires ?? [])],
        plugin: plugin ? { id: plugin.pluginId, status: plugin.status } : null,
        agent_count: agentArchetypes ? agentArchetypes.filter((a) => a === descriptor.id).length : null,
        agent_settings: archetypeSettingFields(descriptor.agentSettings),
      };
    });
}

export function createOperatorArchetypesRouter(deps: OperatorArchetypesDeps): Router {
  const router = Router();
  router.get('/', async (_req: Request, res: Response) => {
    let agentArchetypes: readonly string[] | undefined;
    try {
      agentArchetypes = await deps.listAgentArchetypes?.();
    } catch {
      agentArchetypes = undefined;
    }
    res.json({
      archetypes: buildOperatorArchetypes(listArchetypes(), installedArchetypePlugins(deps.sources()), agentArchetypes),
    });
  });
  return router;
}
