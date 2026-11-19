/**
 * #2060 — the kernel-side guard for facilitator-kind agents (spec 2043 §2.3).
 *
 * `assertArchetypeAllows` in `@omadia/orchestrator` is the seam; this module
 * adds the two things that need kernel state: WHICH plugin is the instance's
 * facilitation engine, and how a refusal is answered over HTTP.
 *
 * THE ENGINE IS FOUND BY WHAT IT DELIVERS, NOT BY ID. The installed plugin of
 * manifest kind `archetype` whose descriptor delivers the archetype
 * `facilitator` is the engine. No plugin id is written down anywhere in the
 * kernel. More than one is not "pick the first": a facilitator with two
 * engines would have two sources of truth about a vote, so every grant is
 * refused until the operator removes one.
 *
 * THE TRUST STEP IS THE INSTALL. An archetype plugin is installed, and
 * updated into one, only on the operator's explicit confirmation of its
 * descriptor (#2088). Until K6 a second form existed (a `provides:
 * facilitationEngine@1` line, trusted once the operator had granted the
 * plugin its database ledger); it is gone, and with it the state `ungranted`.
 * The SQL grant keeps its own job: without it the plugin has no database and
 * does not start, which the status reports as `inactive`.
 */

import type { Response } from 'express';

import {
  ConfigValidationError,
  ArchetypeOmissionError,
  FACILITATOR_ARCHETYPE,
  archetypeOf,
  archetypeOmits,
  isArchetype,
  type ArchetypeBearer,
} from '@omadia/orchestrator';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { FacilitatorContractError } from '../services/facilitatorContract.js';

export interface FacilitationEngineSources {
  readonly installedRegistry: Pick<InstalledRegistry, 'list'> | undefined;
  readonly catalog: Pick<PluginCatalog, 'get'> | undefined;
}

/** Is this plugin the kind that runs facilitations: an archetype plugin that
 *  delivers the archetype `facilitator`? */
export function declaresFacilitationEngine(
  plugin: { readonly kind?: string; readonly archetype?: { readonly id: string } } | undefined,
): boolean {
  return plugin?.kind === 'archetype' && plugin.archetype?.id === FACILITATOR_ARCHETYPE;
}

function declaredEngines(sources: FacilitationEngineSources): { id: string; errored: boolean }[] {
  const { installedRegistry, catalog } = sources;
  if (!installedRegistry || !catalog) return [];
  return installedRegistry
    .list()
    .filter((entry) => declaresFacilitationEngine(catalog.get(entry.id)?.plugin))
    .map((entry) => ({ id: entry.id, errored: entry.status === 'errored' }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The installed plugins that count as engine candidates.
 *
 * A healthy candidate outranks an errored one, so a broken leftover does not
 * make a working engine ambiguous. But when the ONLY engine plugin is
 * errored, it still counts: dropping it would report "no engine installed"
 * where the operator has to be told that the installed one did not start.
 */
export function facilitationEnginePluginIds(sources: FacilitationEngineSources): string[] {
  const declared = declaredEngines(sources);
  const healthy = declared.filter((entry) => !entry.errored);
  return (healthy.length > 0 ? healthy : declared).map((entry) => entry.id);
}

export type FacilitationEngineResolution =
  | { readonly state: 'bound'; readonly pluginId: string }
  | { readonly state: 'none' }
  | { readonly state: 'ambiguous'; readonly pluginIds: readonly string[] };

export function resolveFacilitationEngine(
  sources: FacilitationEngineSources,
): FacilitationEngineResolution {
  const ids = facilitationEnginePluginIds(sources);
  if (ids.length === 0) return { state: 'none' };
  if (ids.length > 1) return { state: 'ambiguous', pluginIds: ids };
  return { state: 'bound', pluginId: ids[0]! };
}

/** The grants a facilitator may hold: the engine's, or nothing. */
export function facilitatorGrantablePluginIds(sources: FacilitationEngineSources): readonly string[] {
  const engine = resolveFacilitationEngine(sources);
  return engine.state === 'bound' ? [engine.pluginId] : [];
}

/** A plugin grant a facilitator was refused, with the reason an operator can act on. */
export class FacilitatorGrantRefusedError extends ArchetypeOmissionError {
  constructor(
    agentSlug: string,
    readonly refusedPluginIds: readonly string[],
    readonly engine: FacilitationEngineResolution,
    archetype: string = FACILITATOR_ARCHETYPE,
  ) {
    super('plugin_grant', agentSlug, archetype);
    const detail =
      engine.state === 'bound'
        ? `only '${engine.pluginId}' (the facilitation engine) can be granted`
        : engine.state === 'none'
          ? 'no facilitation engine plugin is installed, so nothing can be granted yet'
          : `more than one facilitation engine is installed (${engine.pluginIds.join(', ')}); remove all but one`;
    this.message = `${this.message}. Refused: ${refusedPluginIds.join(', ')} — ${detail}`;
  }
}

/**
 * Refuse any ENABLED grant to a facilitator other than the engine's. A
 * disabled row grants nothing and is allowed through, so an operator can
 * still switch a stale grant off.
 */
export function assertFacilitatorPluginGrants(
  agent: { readonly slug: string } & ArchetypeBearer,
  grants: readonly { readonly pluginId: string; readonly enabled?: boolean | undefined }[],
  sources: FacilitationEngineSources,
): void {
  if (!archetypeOmits(agent, 'plugin_grant')) return;
  // The one grant an archetype that omits plugin grants may hold is its own
  // engine: today the facilitation engine, for a facilitator.
  const engine = resolveFacilitationEngine(sources);
  const allowed =
    engine.state === 'bound' && isArchetype(agent, FACILITATOR_ARCHETYPE) ? engine.pluginId : undefined;
  const refused = grants
    .filter((g) => g.enabled !== false && g.pluginId !== allowed)
    .map((g) => g.pluginId);
  if (refused.length > 0) {
    throw new FacilitatorGrantRefusedError(agent.slug, refused, engine, archetypeOf(agent));
  }
}

/**
 * The other direction: the engine's tools are for facilitators only. A
 * standard agent that could start and count a vote would be the partial
 * moderator this kind exists to replace.
 */
export function assertEngineOnlyForFacilitators(
  agent: { readonly slug: string } & ArchetypeBearer,
  grants: readonly { readonly pluginId: string; readonly enabled?: boolean | undefined }[],
  sources: FacilitationEngineSources,
): void {
  // #2088 — an archetype plugin belongs to the agents of ITS archetype and is
  // attached to nobody else (spec 2042 §5.10). The facilitation engine is one
  // (the archetype `facilitator`), so this is the whole rule since K6.
  const own = archetypeOf(agent);
  const foreign = grants
    .filter((g) => g.enabled !== false)
    .map((g) => ({ id: g.pluginId, plugin: sources.catalog?.get(g.pluginId)?.plugin }))
    .filter(({ plugin }) => plugin?.kind === 'archetype' && plugin.archetype !== undefined && plugin.archetype.id !== own);
  if (foreign.length > 0) {
    const named = foreign.map(({ id, plugin }) => `${id} (archetype '${plugin?.archetype?.id ?? '?'}')`).join(', ');
    throw new ConfigValidationError(
      `agent "${agent.slug}" has the archetype '${own}': an archetype plugin can only be granted to agents of its own archetype — refused: ${named}`,
    );
  }
}

/**
 * Answer a facilitator refusal. Returns `true` when `err` was one and the
 * response was written. 409 like every other domain refusal on these
 * routers; 422 for an identity that conflicts with the neutrality contract,
 * with the findings so the editor can point at them.
 */
export function respondFacilitatorRefusal(res: Response, err: unknown): boolean {
  // Matched on the stable `code`, not `instanceof`: the orchestrator package
  // can be loaded twice (source and build), and a refusal must not turn into
  // a 500 because the class came from the other copy.
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'facilitator_contract_violation') {
    const violation = err as FacilitatorContractError;
    res.status(422).json({
      error: code,
      message: violation.message,
      issues: violation.issues,
    });
    return true;
  }
  if (code === 'facilitator_omission') {
    const refusal = err as ArchetypeOmissionError & {
      readonly refusedPluginIds?: readonly string[];
    };
    res.status(409).json({
      error: code,
      omission: refusal.omission,
      ...(refusal.archetype ? { archetype: refusal.archetype } : {}),
      message: refusal.message,
      ...(refusal.refusedPluginIds ? { refused_plugins: refusal.refusedPluginIds } : {}),
    });
    return true;
  }
  return false;
}
