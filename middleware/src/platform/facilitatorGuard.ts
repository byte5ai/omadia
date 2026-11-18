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
 *
 * DECLARING IS NOT ENOUGH. A manifest line costs a plugin nothing, and being
 * the engine means reading every message of a moderated conversation and
 * speaking as the facilitator. So a plugin that declares the capability is a
 * CANDIDATE; it becomes the engine (`bound`) only once the operator has
 * granted it its database ledger — the same explicit, audited step the engine
 * cannot work without anyway. Until then the state is `ungranted`: nothing is
 * attached, nothing is answered, and the status endpoint says which plugin is
 * waiting for the grant.
 */

import type { Response } from 'express';

import {
  ConfigValidationError,
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
  /**
   * Has the operator granted this plugin its SQL ledger? The trust step.
   * Absent = no grant store on this host (minimal mounts, unit tests): the
   * declaration alone decides. The kernel always passes it.
   */
  readonly isSqlGranted?: (pluginId: string) => boolean;
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
  /** One plugin declares the capability; the operator has not granted it SQL. */
  | { readonly state: 'ungranted'; readonly pluginId: string }
  | { readonly state: 'none' }
  | { readonly state: 'ambiguous'; readonly pluginIds: readonly string[] };

export function resolveFacilitationEngine(
  sources: FacilitationEngineSources,
): FacilitationEngineResolution {
  const ids = facilitationEnginePluginIds(sources);
  if (ids.length === 0) return { state: 'none' };
  if (ids.length > 1) return { state: 'ambiguous', pluginIds: ids };
  const pluginId = ids[0]!;
  if (sources.isSqlGranted && !sources.isSqlGranted(pluginId)) {
    return { state: 'ungranted', pluginId };
  }
  return { state: 'bound', pluginId };
}

/**
 * A synchronous view of "which plugins hold a SQL grant", for the callers
 * that resolve the engine on a hot path. Refreshed explicitly where a change
 * must take effect at once (install, activation, boot) and by itself when a
 * read finds it older than `maxAgeMs`, so a grant given or revoked in the
 * operator UI is noticed without a restart. Unknown = not granted.
 */
export function createSqlGrantView(deps: {
  listGranted: () => Promise<readonly string[]>;
  maxAgeMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}): { isGranted(pluginId: string): boolean; refresh(): Promise<void> } {
  const now = deps.now ?? Date.now;
  const maxAgeMs = deps.maxAgeMs ?? 30_000;
  let granted: ReadonlySet<string> = new Set();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    inFlight ??= deps
      .listGranted()
      .then((ids) => {
        granted = new Set(ids);
        loadedAt = now();
      })
      .catch((err: unknown) => {
        deps.log?.(
          `[facilitator] SQL grant lookup failed, keeping the last known state: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  return {
    isGranted(pluginId: string): boolean {
      if (now() - loadedAt > maxAgeMs) void refresh();
      return granted.has(pluginId);
    },
    refresh,
  };
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
        : engine.state === 'ungranted'
          ? `'${engine.pluginId}' declares the facilitation engine but has no database grant yet; grant it on the plugin page first`
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
 * The other direction: the engine's tools are for facilitators only. A
 * standard agent that could start and count a vote would be the partial
 * moderator this kind exists to replace.
 */
export function assertEngineOnlyForFacilitators(
  agent: { readonly slug: string; readonly kind?: AgentKind },
  grants: readonly { readonly pluginId: string; readonly enabled?: boolean | undefined }[],
  sources: FacilitationEngineSources,
): void {
  if (isFacilitatorKind(agent)) return;
  const engines = new Set(facilitationEnginePluginIds(sources));
  const refused = grants.filter((g) => g.enabled !== false && engines.has(g.pluginId)).map((g) => g.pluginId);
  if (refused.length > 0) {
    throw new ConfigValidationError(
      `agent "${agent.slug}" is not a facilitator: the facilitation engine (${refused.join(', ')}) can only be granted to a facilitator`,
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
