/**
 * #2060 — the kernel-side guard for facilitator-kind agents (spec 2043 §2.3).
 *
 * `assertNotFacilitator` in `@omadia/orchestrator` is the seam; this module
 * adds the two things that need kernel state: WHICH plugin is the instance's
 * facilitation engine, and how a refusal is answered over HTTP.
 *
 * THE ENGINE IS FOUND BY CAPABILITY, NOT BY ID. A plugin declares
 * `facilitationEngine@1` under `provides` in its manifest; the one installed,
 * non-errored plugin that does is the engine. No plugin id is written down
 * anywhere in the kernel. More than one provider is not "pick the first": a
 * facilitator with two engines would have two sources of truth about a vote,
 * so every grant is refused until the operator removes one.
 */

import type { Response } from 'express';

import {
  FacilitatorOmissionError,
  isFacilitatorKind,
  type AgentKind,
} from '@omadia/orchestrator';
import { FACILITATION_ENGINE_CAPABILITY } from '@omadia/plugin-api';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { PluginCatalog } from '../plugins/manifestLoader.js';
import type { FacilitatorContractError } from '../services/facilitatorContract.js';

export interface FacilitationEngineSources {
  readonly installedRegistry: Pick<InstalledRegistry, 'list'> | undefined;
  readonly catalog: Pick<PluginCatalog, 'get'> | undefined;
}

/** Installed, non-errored plugins whose manifest provides the engine capability. */
export function facilitationEnginePluginIds(sources: FacilitationEngineSources): string[] {
  const { installedRegistry, catalog } = sources;
  if (!installedRegistry || !catalog) return [];
  return installedRegistry
    .list()
    .filter((entry) => entry.status !== 'errored')
    .map((entry) => entry.id)
    .filter((id) =>
      (catalog.get(id)?.plugin.provides ?? []).includes(FACILITATION_ENGINE_CAPABILITY),
    )
    .sort();
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
export class FacilitatorGrantRefusedError extends FacilitatorOmissionError {
  constructor(
    agentSlug: string,
    readonly refusedPluginIds: readonly string[],
    readonly engine: FacilitationEngineResolution,
  ) {
    super('plugin_grant', agentSlug);
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
  agent: { readonly slug: string; readonly kind?: AgentKind },
  grants: readonly { readonly pluginId: string; readonly enabled?: boolean | undefined }[],
  sources: FacilitationEngineSources,
): void {
  if (!isFacilitatorKind(agent)) return;
  const engine = resolveFacilitationEngine(sources);
  const allowed = engine.state === 'bound' ? engine.pluginId : undefined;
  const refused = grants
    .filter((g) => g.enabled !== false && g.pluginId !== allowed)
    .map((g) => g.pluginId);
  if (refused.length > 0) {
    throw new FacilitatorGrantRefusedError(agent.slug, refused, engine);
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
    const refusal = err as FacilitatorOmissionError & {
      readonly refusedPluginIds?: readonly string[];
    };
    res.status(409).json({
      error: code,
      omission: refusal.omission,
      message: refusal.message,
      ...(refusal.refusedPluginIds ? { refused_plugins: refusal.refusedPluginIds } : {}),
    });
    return true;
  }
  return false;
}
