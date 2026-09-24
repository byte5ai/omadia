/**
 * Per-plugin LLM provider assignment, shared by the providers admin route
 * (`POST /api/v1/admin/providers/assignment`) and the subscription-login
 * hand-off (OM-79, #994).
 *
 * The rules used to live inline in the route handler. The hand-off needs the
 * very same fail-closed checks (tool-less provider vs tool-driving plugin,
 * model/provider mismatch, routing-disable on a non-Anthropic switch), so they
 * moved here instead of being duplicated.
 */
import {
  listModelsByProvider,
  modelForClass,
  resolveModelRef,
  type ModelInfo,
  type ProviderId,
} from '@omadia/llm-provider';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import type { CliBackendsSnapshot } from './cliBackendDetector.js';
import {
  DEFAULT_PROVIDER,
  LLM_PLUGINS,
  readStringConfig,
  resolveProviderVerification,
  type LlmProviderCatalogView,
  type ProviderKeyVault,
} from './pluginLlmReadiness.js';

export interface ProviderAssignmentDeps {
  readonly installedRegistry: InstalledRegistry;
  /** Tear down + re-activate a plugin so it re-reads its config. */
  readonly reactivate?: (pluginId: string) => Promise<void>;
  readonly llmProviderCatalog?: LlmProviderCatalogView;
}

export interface ProviderAssignmentInput {
  readonly pluginId: string;
  readonly provider: string;
  readonly model: string;
}

export type ProviderAssignmentResult =
  | {
      readonly ok: true;
      readonly pluginId: string;
      readonly provider: string;
      /** The bare vendor model id that was persisted. */
      readonly model: string;
    }
  | {
      readonly ok: false;
      /** HTTP status the route maps this failure to. */
      readonly status: 400 | 404 | 500;
      readonly code: string;
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// #1076 (OM-102 follow-up) — provider dependents.
//
// `@omadia/orchestrator-extras` falls back to the orchestrator's `llm_provider`
// and resolves it ONCE per activate(). A change to the orchestrator's provider
// therefore has to rebuild extras too — on the writing side, the lesson of #989
// (a capability-relevant change is a rebuild, not an update). Doing it inside
// extras as a lazy lookup is ruled out: the orchestrator captures extras'
// `factExtractor` / `contextRetriever` / `sessionBriefing` instances eagerly in
// its own activate(), so the instances themselves must be replaced.
//
// That capture is also why the ORDER matters: dependents first, then the plugin
// itself — the boot order. Rebuilding extras after the orchestrator would leave
// the running orchestrator holding the old extras instances.
// ---------------------------------------------------------------------------

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

/**
 * A provider dependent (extras, for the orchestrator) did not come back up
 * after the rebuild a provider change triggered. The primary's config is
 * persisted and the primary itself WAS rebuilt on it (`primaryApplied`), but
 * it re-captured whatever the dependent left published, so the features the
 * dependent serves (memory recall, fact extraction, briefing) are down.
 */
export class ProviderDependentRebuildError extends Error {
  readonly primaryId: string;
  readonly dependentId: string;
  readonly primaryApplied = true;

  constructor(primaryId: string, dependentId: string, reason: string) {
    super(
      `${primaryId} runs on its new provider, but its dependent ${dependentId} failed to rebuild: ${reason}`,
    );
    this.name = 'ProviderDependentRebuildError';
    this.primaryId = primaryId;
    this.dependentId = dependentId;
  }
}

/**
 * Rebuild `dependentId`; return why it did not come back up, or `undefined`
 * when it did.
 *
 * The production `reactivate` (`reactivateAgent` → `installService.reactivate`)
 * never throws on an activation failure: it records `markActivationFailed`,
 * flips the entry to `errored` and returns. A successful reactivation lifts
 * `errored` again (`clearActivationError`), so `errored` right after the call
 * means THIS rebuild failed. A throwing `reactivate` counts as a failure too.
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
  const entry = installedRegistry.get(dependentId);
  if (entry?.status !== 'errored') return undefined;
  return entry.last_activation_error ?? 'activation failed (no error recorded)';
}

export interface ProviderWriteFacts {
  /** The effective provider differs before vs after the write. */
  readonly providerChanged: boolean;
  /**
   * The write carried `llm_provider` at all, changed or not. A same-provider
   * re-save is the retry the UI recommends after a failed dependent rebuild
   * ("Save again"), so it must reach a dependent still left `errored`.
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
 * Reactivate `pluginId` after a config write. When its provider changed, every
 * INSTALLED provider dependent is rebuilt first; when `llm_provider` was
 * re-written unchanged, only the dependents still `errored` are (see
 * {@link dependentsToRebuild}). A failing dependent does not
 * stop the primary from being rebuilt (it re-captures whatever the dependent
 * left published). Afterwards the first dependent failure is thrown as a
 * {@link ProviderDependentRebuildError}, so the caller reports the write as
 * failed instead of silently half-applied. A dependent counts as failed when
 * `reactivate` throws OR leaves it `errored` in the registry; the production
 * `reactivate` only ever does the latter.
 */
export async function reactivateAfterProviderWrite(
  deps: ProviderReactivationDeps,
  pluginId: string,
  opts: ProviderWriteFacts,
): Promise<void> {
  const reactivate = deps.reactivate;
  if (reactivate === undefined) return;
  const dependents = dependentsToRebuild(deps.installedRegistry, pluginId, opts);
  const failures: ProviderDependentRebuildError[] = [];
  for (const id of dependents) {
    const reason = await rebuildDependent(deps.installedRegistry, reactivate, id);
    if (reason !== undefined) {
      failures.push(new ProviderDependentRebuildError(pluginId, id, reason));
    }
  }
  try {
    await reactivate(pluginId);
  } catch (err) {
    // The primary's own failure is the headline; still say what the
    // dependents reported on the way instead of dropping it.
    for (const f of failures) console.error(`[providers] ${f.message}`);
    throw err;
  }
  const [firstFailure, ...otherFailures] = failures;
  // Only one error can be thrown; the rest are logged, not dropped.
  for (const f of otherFailures) console.error(`[providers] ${f.message}`);
  if (firstFailure !== undefined) throw firstFailure;
}

/**
 * Validate and persist `{ provider, model }` for an LLM-consuming plugin, then
 * reactivate it (on a provider change, its provider dependents first). Pure
 * with respect to HTTP: the route turns the result into a response, the
 * hand-off logs it.
 */
export async function applyProviderAssignment(
  deps: ProviderAssignmentDeps,
  input: ProviderAssignmentInput,
): Promise<ProviderAssignmentResult> {
  const pluginId = input.pluginId;
  const provider = input.provider.trim();
  const model = input.model.trim();

  const desc = LLM_PLUGINS.find((p) => p.id === pluginId);
  if (desc === undefined) {
    return {
      ok: false,
      status: 400,
      code: 'providers.unknown_plugin',
      message: `'${pluginId}' is not a selectable LLM plugin`,
    };
  }
  if (provider.length === 0 || model.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'providers.invalid_request',
      message: 'body must be { pluginId, provider, model }',
    };
  }
  if (!deps.installedRegistry.has(pluginId)) {
    return {
      ok: false,
      status: 404,
      code: 'providers.not_installed',
      message: `${pluginId} is not installed`,
    };
  }
  // Fail closed: never assign a tool-less provider (the `claude-cli` Shape-2
  // backend) to a plugin that drives a tool loop — it would silently disable
  // tools/memory/sub-agents. Tool-less plugins (extractors/classifiers) are
  // fine and are the intended target for the subscription CLI.
  const providerWire = deps.llmProviderCatalog?.get(provider)?.wireFormat;
  if (desc.requiresTools === true && providerWire === 'claude-cli') {
    return {
      ok: false,
      status: 400,
      code: 'providers.tool_incompatible',
      message: `${desc.label} needs tool support; the subscription CLI provider is tool-less. Use it only for tool-less roles (e.g. extraction/classification).`,
    };
  }
  // Resolve against the CHOSEN provider so class refs (`class:frontier`),
  // provider-qualified ids (`openai:gpt-5.5`) and legacy aliases (`opus`) all
  // disambiguate to it. Guard the classic mistake: a known model that belongs
  // to a DIFFERENT provider (e.g. claude-* assigned to openai). Unknown models
  // (custom / openai-compatible) are allowed through.
  const known = resolveModelRef(model, { defaultProvider: provider as ProviderId });
  if (known !== undefined && known.provider !== provider) {
    return {
      ok: false,
      status: 400,
      code: 'providers.model_provider_mismatch',
      message: `model '${model}' belongs to provider '${known.provider}', not '${provider}'`,
    };
  }
  // Persist the bare vendor id the adapter expects — normalise qualified ids /
  // class refs / aliases to `modelId`; pass unknown custom ids through as-is.
  const storeModel = known?.modelId ?? model;

  const entry = deps.installedRegistry.get(pluginId);
  const nextConfig: Record<string, unknown> = { ...(entry?.config ?? {}) };
  nextConfig['llm_provider'] = provider;
  for (const mk of desc.modelKeys) nextConfig[mk] = storeModel;
  if (provider !== 'anthropic' && desc.extraOnNonAnthropic !== undefined) {
    for (const [k, v] of Object.entries(desc.extraOnNonAnthropic)) {
      nextConfig[k] = v;
    }
  }

  try {
    await deps.installedRegistry.updateConfig(pluginId, nextConfig);
    await reactivateAfterProviderWrite(deps, pluginId, {
      providerChanged: isEffectiveProviderChange(entry?.config, nextConfig),
      providerWritten: true,
    });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      code: 'providers.apply_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, pluginId, provider, model: storeModel };
}

// ---------------------------------------------------------------------------
// OM-79 (#994) — subscription-login hand-off.
//
// After `claude auth login` succeeds, everything needed to run the orchestrator
// on the subscription exists (keyless provider, provider factory, readiness
// gate), except the one setting nobody names: `llm_provider` still points at
// `anthropic`, the orchestrator asks the vault for a key, finds none and never
// publishes `chatAgent@1`. Every operator surface then answers 503.
//
// The hand-off flips that assignment automatically, but only where there is
// nothing to lose: the plugin still sits on the platform DEFAULT provider
// (`llm_provider` unset or `anthropic`) AND that provider has no credential.
// Anything the operator chose explicitly — another vendor, an OAuth provider, a
// keyless local server — is never overridden, credential or not.
// ---------------------------------------------------------------------------

/** The keyless provider the in-app login connects. */
export const SUBSCRIPTION_CLI_PROVIDER: ProviderId = 'claude-cli';

export interface SubscriptionAutoAssignDeps extends ProviderAssignmentDeps {
  readonly vault?: ProviderKeyVault;
  /** Pre-detected CLI snapshot; forwarded to the verification so the current
   *  provider's "connected" verdict is computed the same way the admin page
   *  computes it. */
  readonly cliSnapshot?: CliBackendsSnapshot | undefined;
  readonly log?: (message: string) => void;
}

export interface SubscriptionAutoAssignOutcome {
  /** Plugins whose assignment was switched to the subscription CLI. */
  readonly assigned: readonly string[];
  /** Plugins left untouched, with the reason. */
  readonly skipped: ReadonlyArray<{ readonly pluginId: string; readonly reason: string }>;
}

/** The model the hand-off assigns: the provider's balanced class default, or
 *  its first registered model when no class default is declared. */
export function defaultSubscriptionCliModel(): ModelInfo | undefined {
  return (
    modelForClass('balanced', SUBSCRIPTION_CLI_PROVIDER) ??
    listModelsByProvider(SUBSCRIPTION_CLI_PROVIDER)[0]
  );
}

/**
 * Point every installed, tool-less-capable LLM plugin whose current provider
 * has no credential at the subscription CLI. Idempotent: a plugin already on
 * the CLI, or on a provider with a key/OAuth grant, is skipped.
 */
export async function autoAssignSubscriptionCli(
  deps: SubscriptionAutoAssignDeps,
): Promise<SubscriptionAutoAssignOutcome> {
  const log = deps.log ?? ((): void => undefined);
  const assigned: string[] = [];
  const skipped: Array<{ pluginId: string; reason: string }> = [];

  const model = defaultSubscriptionCliModel();
  if (model === undefined) {
    log(
      `[providers] subscription hand-off skipped: provider '${SUBSCRIPTION_CLI_PROVIDER}' has no registered models`,
    );
    return { assigned, skipped: LLM_PLUGINS.map((p) => ({ pluginId: p.id, reason: 'no_cli_model' })) };
  }

  // #1076 — plugins that others inherit their provider from go LAST. Their
  // assignment rebuilds those dependents and then themselves; processing them
  // after the dependents' own assignment means the final rebuild sees every
  // dependent's final config (the orchestrator ends up holding an extras
  // instance with extras' hand-off model, not an intermediate one). The UI
  // order of `LLM_PLUGINS` stays untouched.
  const hasDependents = (id: string): boolean => providerDependentsOf(id).length > 0;
  const handOffOrder = [
    ...LLM_PLUGINS.filter((p) => !hasDependents(p.id)),
    ...LLM_PLUGINS.filter((p) => hasDependents(p.id)),
  ];

  for (const desc of handOffOrder) {
    if (!deps.installedRegistry.has(desc.id)) {
      skipped.push({ pluginId: desc.id, reason: 'not_installed' });
      continue;
    }
    if (desc.requiresTools === true) {
      skipped.push({ pluginId: desc.id, reason: 'requires_tools' });
      continue;
    }
    const cfg = deps.installedRegistry.get(desc.id)?.config ?? {};
    const current = (readStringConfig(cfg, 'llm_provider') ?? DEFAULT_PROVIDER) as ProviderId;
    if (current === SUBSCRIPTION_CLI_PROVIDER) {
      skipped.push({ pluginId: desc.id, reason: 'already_cli' });
      continue;
    }
    // Only the platform DEFAULT is ever overridden. `llm_provider` unset means
    // the operator never chose anything, and the default `anthropic` without a
    // key is exactly the fresh-install state OM-79 describes. An EXPLICIT choice
    // (`openai`, an OAuth provider, a keyless local server, …) is the operator's
    // decision — even when it currently lacks a credential — and is left alone;
    // the subscription tab's explainer tells them where to re-point it.
    if (readStringConfig(cfg, 'llm_provider') !== undefined && current !== DEFAULT_PROVIDER) {
      skipped.push({ pluginId: desc.id, reason: `explicit_provider:${current}` });
      continue;
    }
    const verification = await resolveProviderVerification(current, {
      vault: deps.vault,
      llmProviderCatalog: deps.llmProviderCatalog,
      cliSnapshot: deps.cliSnapshot,
    });
    if (verification.status !== 'no_key') {
      skipped.push({ pluginId: desc.id, reason: `provider_has_credential:${verification.status}` });
      continue;
    }
    const result = await applyProviderAssignment(deps, {
      pluginId: desc.id,
      provider: SUBSCRIPTION_CLI_PROVIDER,
      model: model.modelId,
    });
    if (result.ok) {
      assigned.push(desc.id);
      log(
        `[providers] subscription hand-off: ${desc.id} had no credential for '${current}', now runs on '${SUBSCRIPTION_CLI_PROVIDER}' (model=${result.model})`,
      );
    } else {
      skipped.push({ pluginId: desc.id, reason: result.code });
      log(`[providers] subscription hand-off: ${desc.id} not switched (${result.code}: ${result.message})`);
    }
  }
  return { assigned, skipped };
}
