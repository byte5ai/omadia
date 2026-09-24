/**
 * Per-plugin LLM provider assignment, shared by the providers admin route
 * (`POST /api/v1/admin/providers/assignment`) and the subscription-login
 * hand-off (OM-79, #994).
 *
 * The rules used to live inline in the route handler. The hand-off needs the
 * very same fail-closed checks (tool-less provider vs tool-driving plugin,
 * model/provider mismatch, routing-disable on a non-Anthropic switch), so they
 * moved here instead of being duplicated.
 *
 * Model refs (#1083): a class ref (`class:frontier`) is stored VERBATIM — the
 * same as the runtime config PATCH does — so the agent follows the provider's
 * catalog instead of being pinned to today's frontier model. Every runtime
 * consumer resolves it per call (`resolveConfiguredModel` /
 * `resolveModelRefStrict`, #1079). It fails closed only when the provider
 * serves no model at all. Provider-qualified ids and legacy aliases are still
 * normalised to the bare vendor `modelId`.
 */
import {
  isClassRef,
  listModelsByProvider,
  modelForClass,
  resolveConfiguredModel,
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
      /** What was persisted: a class ref as given, else the bare vendor id. */
      readonly model: string;
      /** The concrete model `model` resolves to for `provider` right now —
       *  equal to `model` unless that is a class ref. */
      readonly resolvedModel: string;
    }
  | {
      readonly ok: false;
      /** HTTP status the route maps this failure to. */
      readonly status: 400 | 404 | 500;
      readonly code: string;
      readonly message: string;
    };

/**
 * Validate and persist `{ provider, model }` for an LLM-consuming plugin, then
 * reactivate it. Pure with respect to HTTP: the route turns the result into a
 * response, the hand-off logs it.
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
  const resolution = resolveAssignedModel(model, provider);
  if (!resolution.ok) return resolution;
  const { storeModel, resolvedModel } = resolution;

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
    if (deps.reactivate) await deps.reactivate(pluginId);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      code: 'providers.apply_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, pluginId, provider, model: storeModel, resolvedModel };
}

type AssignedModelResolution =
  | { readonly ok: true; readonly storeModel: string; readonly resolvedModel: string }
  | Extract<ProviderAssignmentResult, { ok: false }>;

/**
 * Decide what to persist for `model` under `provider`, and what it resolves
 * to right now.
 *
 *  - class ref → kept verbatim (#1083); resolved with the runtime's own
 *    resolver, which falls back to the nearest class and then to any model the
 *    provider serves. Nothing at all → `providers.model_class_unavailable`.
 *  - anything else → resolved against the CHOSEN provider so qualified ids
 *    (`openai:gpt-5.5`) and legacy aliases (`opus`) disambiguate to it and are
 *    stored as the bare vendor id. A known model of a DIFFERENT provider is the
 *    classic mistake and is rejected; unknown (custom / openai-compatible) ids
 *    pass through as-is.
 */
function resolveAssignedModel(model: string, provider: string): AssignedModelResolution {
  if (isClassRef(model)) {
    const resolved = resolveConfiguredModel(model, provider);
    if (resolved === undefined || isClassRef(resolved)) {
      return {
        ok: false,
        status: 400,
        code: 'providers.model_class_unavailable',
        message: `provider '${provider}' serves no model for '${model}'`,
      };
    }
    return { ok: true, storeModel: model, resolvedModel: resolved };
  }
  const known = resolveModelRef(model, { defaultProvider: provider as ProviderId });
  if (known !== undefined && known.provider !== provider) {
    return {
      ok: false,
      status: 400,
      code: 'providers.model_provider_mismatch',
      message: `model '${model}' belongs to provider '${known.provider}', not '${provider}'`,
    };
  }
  const storeModel = known?.modelId ?? model;
  return { ok: true, storeModel, resolvedModel: storeModel };
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

  for (const desc of LLM_PLUGINS) {
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
