/**
 * #1076 (OM-102 follow-up) — provider dependents.
 *
 * `@omadia/orchestrator-extras` falls back to the orchestrator's `llm_provider`
 * and resolves it ONCE per activate(). A change to the orchestrator's provider
 * therefore has to rebuild extras too — on the writing side, the lesson of #989
 * (a capability-relevant change is a rebuild, not an update). Doing it inside
 * extras as a lazy lookup is ruled out: the orchestrator captures extras'
 * `factExtractor` / `contextRetriever` / `sessionBriefing` instances eagerly in
 * its own activate(), so the instances themselves must be replaced.
 *
 * That capture is also why the ORDER matters: dependents first, then the plugin
 * itself — the boot order. Rebuilding extras after the orchestrator would leave
 * the running orchestrator holding the old extras instances.
 *
 * Every writer of `llm_provider` runs {@link reactivateAfterProviderWrite}:
 * `applyProviderAssignment` (providerAssignment.ts) and the generic config /
 * secrets writes in routes/runtime.ts.
 */
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import { DEFAULT_PROVIDER, LLM_PLUGINS, readStringConfig } from './pluginLlmReadiness.js';

/** Ids of the LLM plugins that inherit their provider from `pluginId`. */
export function providerDependentsOf(pluginId: string): string[] {
  return LLM_PLUGINS.filter((p) => p.inheritsProviderFrom === pluginId).map(
    (p) => p.id,
  );
}

function effectiveProvider(cfg: Record<string, unknown> | undefined): string {
  return (readStringConfig(cfg ?? {}, 'llm_provider') ?? DEFAULT_PROVIDER).trim();
}

/** True when two configs resolve to different providers. Unset means the
 *  platform default, so unset → explicit `anthropic` is NOT a change. */
export function isEffectiveProviderChange(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean {
  return effectiveProvider(before) !== effectiveProvider(after);
}

export interface ProviderReactivationDeps {
  readonly installedRegistry: Pick<InstalledRegistry, 'has' | 'get'>;
  readonly reactivate?: (pluginId: string) => Promise<void>;
}

/** How the written plugin itself came out of the rebuild. */
export interface PrimaryRebuildOutcome {
  /** The effective provider changed with this write. */
  readonly providerChanged: boolean;
  /**
   * Why the primary's own rebuild left it `errored`, or `undefined` when it
   * came back up.
   */
  readonly primaryFailure?: string;
}

/**
 * A provider dependent (extras, for the orchestrator) did not come back up
 * after the rebuild a provider write triggered. The primary's config is
 * persisted and the primary was rebuilt on it, re-capturing whatever the
 * dependent left published, so the features the dependent serves (memory
 * recall, fact extraction, briefing) are down. `primaryApplied` is `true` only
 * when the primary itself came back up.
 */
export class ProviderDependentRebuildError extends Error {
  readonly primaryId: string;
  readonly dependentId: string;
  readonly primaryApplied: boolean;

  constructor(
    primaryId: string,
    dependentId: string,
    reason: string,
    outcome: PrimaryRebuildOutcome,
  ) {
    // The dependent id leads: the UI caps the support detail, and a long
    // activation error of the primary must not cut the dependent's name off.
    super(
      `${dependentId} failed to rebuild after ${primaryId}'s provider write: ${reason}. ${describePrimaryState(primaryId, outcome)}`,
    );
    this.name = 'ProviderDependentRebuildError';
    this.primaryId = primaryId;
    this.dependentId = dependentId;
    this.primaryApplied = outcome.primaryFailure === undefined;
  }
}

/** A same-provider re-save (the retry) must not claim a move to a NEW provider. */
function describePrimaryState(primaryId: string, outcome: PrimaryRebuildOutcome): string {
  if (outcome.primaryFailure !== undefined) {
    return `${primaryId}'s config was saved, but ${primaryId} did not come back up either (${outcome.primaryFailure})`;
  }
  return outcome.providerChanged
    ? `${primaryId} runs on its new provider`
    : `${primaryId} was saved and rebuilt on its unchanged provider`;
}

/**
 * Why `pluginId` is `errored` in the registry right after a rebuild, or
 * `undefined` when it is not. The production `reactivate`
 * (`reactivateAgent` → `installService.reactivate`) never throws on an
 * activation failure: it records `markActivationFailed`, flips the entry to
 * `errored` and returns. A successful reactivation lifts `errored` again
 * (`clearActivationError`), so `errored` right after the call means THIS
 * rebuild failed.
 */
function activationFailure(
  installedRegistry: ProviderReactivationDeps['installedRegistry'],
  pluginId: string,
): string | undefined {
  const entry = installedRegistry.get(pluginId);
  if (entry?.status !== 'errored') return undefined;
  return entry.last_activation_error ?? 'activation failed (no error recorded)';
}

/**
 * Rebuild `dependentId`; return why it did not come back up, or `undefined`
 * when it did. Left `errored` (see {@link activationFailure}) or a throwing
 * `reactivate` both count as a failure.
 */
async function rebuildDependent(
  installedRegistry: ProviderReactivationDeps['installedRegistry'],
  reactivate: (pluginId: string) => Promise<void>,
  dependentId: string,
): Promise<string | undefined> {
  try {
    await reactivate(dependentId);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return activationFailure(installedRegistry, dependentId);
}

export interface ProviderWriteFacts {
  /** The effective provider differs before vs after the write. */
  readonly providerChanged: boolean;
  /**
   * The write carried `llm_provider` at all, changed or not. A same-provider
   * re-save is the retry the UI offers after a failed rebuild, so it must
   * reach a dependent still left `errored`.
   */
  readonly providerWritten?: boolean;
}

/**
 * The installed dependents a write to `pluginId` has to rebuild: all of them on
 * an effective provider change; on a same-provider re-save of `llm_provider`
 * only those still `errored`. Without the second rule a retry after a failed
 * extras rebuild would see no change, rebuild only the primary and answer
 * `ok`, leaving extras down behind a success.
 */
function dependentsToRebuild(
  installedRegistry: ProviderReactivationDeps['installedRegistry'],
  pluginId: string,
  facts: ProviderWriteFacts,
): string[] {
  return providerDependentsOf(pluginId).filter((id) => {
    if (!installedRegistry.has(id)) return false;
    if (facts.providerChanged) return true;
    return facts.providerWritten === true && installedRegistry.get(id)?.status === 'errored';
  });
}

/**
 * Reactivate `pluginId` after a config write, rebuilding its installed
 * provider dependents first (see {@link dependentsToRebuild} for which). A
 * failing dependent does not stop the primary from being rebuilt. Afterwards
 * the first dependent failure is thrown as a
 * {@link ProviderDependentRebuildError}; a dependent counts as failed when
 * `reactivate` throws OR leaves it `errored` (the production `reactivate`
 * only ever does the latter).
 *
 * Returns the primary's own {@link PrimaryRebuildOutcome} when no dependent
 * failed, so a caller whose response does not carry the plugin's status (the
 * providers route) can still report a primary left `errored`. `undefined`
 * when there is no `reactivate` to run.
 */
export async function reactivateAfterProviderWrite(
  deps: ProviderReactivationDeps,
  pluginId: string,
  opts: ProviderWriteFacts,
): Promise<PrimaryRebuildOutcome | undefined> {
  const reactivate = deps.reactivate;
  if (reactivate === undefined) return undefined;
  const dependents = dependentsToRebuild(deps.installedRegistry, pluginId, opts);
  const dependentFailures: Array<{ readonly id: string; readonly reason: string }> = [];
  for (const id of dependents) {
    const reason = await rebuildDependent(deps.installedRegistry, reactivate, id);
    if (reason !== undefined) dependentFailures.push({ id, reason });
  }
  try {
    await reactivate(pluginId);
  } catch (err) {
    // The primary's own failure is the headline; still say what the
    // dependents reported on the way instead of dropping it.
    for (const f of dependentFailures) {
      console.error(`[providers] ${pluginId}'s dependent ${f.id} failed to rebuild: ${f.reason}`);
    }
    throw err;
  }
  const outcome: PrimaryRebuildOutcome = {
    providerChanged: opts.providerChanged,
    primaryFailure: activationFailure(deps.installedRegistry, pluginId),
  };
  const failures = dependentFailures.map(
    (f) => new ProviderDependentRebuildError(pluginId, f.id, f.reason, outcome),
  );
  const [firstFailure, ...otherFailures] = failures;
  // Only one error can be thrown; the rest are logged, not dropped.
  for (const f of otherFailures) console.error(`[providers] ${f.message}`);
  if (firstFailure !== undefined) throw firstFailure;
  return outcome;
}
