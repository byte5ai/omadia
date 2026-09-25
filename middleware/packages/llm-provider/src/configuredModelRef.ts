/**
 * Resolution of CONFIGURED model refs (`ORCHESTRATOR_MODEL`, `SUB_AGENT_MODEL`,
 * a manifest's `llm.prefers.model`, a plugin's `ctx.llm` request, …) to the
 * concrete vendor `modelId` a provider adapter can send.
 *
 * Every provider adapter sends `model` RAW. A class ref (`class:frontier`) or a
 * provider-qualified id (`anthropic:claude-opus-5`) that reaches the vendor API
 * unresolved is a 404 on every call (#296, #1079). This module is the ONE
 * resolver the orchestrator, the dynamic sub-agents, the verifier, the
 * orchestrator-extras and the plugin `ctx.llm` all share, so no call site can
 * drift into its own partial resolution again.
 */
import {
  coerceModelToProvider,
  isClassRef,
  listModelsByProvider,
  modelForClass,
  resolveModelRef,
  type ModelClass,
} from './modelRegistry.js';

/** Preference order when a class ref cannot be served exactly (a provider
 *  with no model of that class): the nearest class, then anything served. */
const CLASS_FALLBACK_ORDER = ['frontier', 'balanced', 'fast'] as const;

/**
 * Resolve a CONFIGURED model ref — class ref (`class:frontier`), legacy alias
 * (`opus`), provider-qualified id or bare vendor id — to the bare `modelId`
 * to send to `providerId`. Unlike `resolveModelIdForProvider` a class ref is
 * never passed through raw: the vendor API would 404 on it. When the provider
 * serves no model of the requested class, the nearest class's default is used,
 * then the first model the provider serves at all. Returns `undefined` only
 * when the ref is empty or the registry knows nothing about the provider.
 */
export function resolveConfiguredModel(
  ref: string | null | undefined,
  providerId: string | undefined,
): string | undefined {
  const trimmed = ref?.trim();
  if (!trimmed) return undefined;
  const resolved = resolveModelIdForProvider(trimmed, providerId);
  if (resolved !== undefined && !isClassRef(resolved)) return resolved;
  if (!isClassRef(trimmed)) return resolved;
  const provider = providerId ?? 'anthropic';
  for (const cls of CLASS_FALLBACK_ORDER) {
    const hit = modelForClass(cls, provider);
    if (hit !== undefined) return hit.modelId;
  }
  return listModelsByProvider(provider)[0]?.modelId;
}

/**
 * Resolve a model ref to the active provider's concrete bare `modelId`
 * (issue #296).
 *
 * Both the orchestrator main loop AND in-process sub-agents send `model` RAW to
 * a single concrete provider adapter — there is no ref→modelId resolution in
 * the send path. The Admin picker stores a provider-qualified id
 * (`anthropic:claude-opus-4-8`) or a legacy alias (`opus`); sending either raw
 * 404s every turn. Returns:
 *   - registry-known, same provider → the bare vendor `modelId`
 *   - registry-known, DIFFERENT provider than `activeProvider` → `undefined`
 *     (cross-provider is out of scope and would 404 on the wrong adapter — the
 *     caller falls back to its own default)
 *   - registry-UNKNOWN (not in the curated set) → the raw trimmed ref. The
 *     registry is a curated subset, not the universe of valid API ids — an id
 *     the registry does not list may still be served (e.g. an undated default
 *     or an operator-typed id). Passing it through preserves pre-resolution
 *     behaviour, matching the `resolveModelRef(x)?.modelId ?? x` contract used
 *     elsewhere (e.g. `builderPreviewPrompt`).
 *   - empty / whitespace → `undefined` (no model specified → caller falls back)
 *
 * The CLI provider owns its own alias scheme (`sonnet`/`opus`) and must be
 * handled by the caller BEFORE this — pass its refs through untouched.
 */
export function resolveModelIdForProvider(
  ref: string | null | undefined,
  activeProvider: string | undefined,
): string | undefined {
  const trimmed = ref?.trim();
  if (!trimmed) return undefined;
  const info = resolveModelRef(
    trimmed,
    activeProvider ? { defaultProvider: activeProvider } : {},
  );
  if (info === undefined) return trimmed;
  if (activeProvider && info.provider !== activeProvider) return undefined;
  return info.modelId;
}

/**
 * A class ref that nothing could turn into a concrete model id: the provider
 * serves no model at all in the registry (e.g. its provider plugin was
 * uninstalled) and no pinned default exists. Thrown instead of sending the
 * class ref to the vendor, which would answer with an opaque 404.
 */
export class UnresolvedModelRefError extends Error {
  readonly ref: string;
  readonly providerId: string;
  readonly configKey: string;

  constructor(ref: string, providerId: string, configKey: string) {
    super(
      `${configKey} is '${ref}', but provider '${providerId}' serves no model ` +
        `for that class — set ${configKey} to a concrete model id of ` +
        `'${providerId}' (or register the provider's models)`,
    );
    this.name = 'UnresolvedModelRefError';
    this.ref = ref;
    this.providerId = providerId;
    this.configKey = configKey;
  }
}

export interface ResolveModelRefStrictOptions {
  /** The operator-facing name of the setting the ref came from — named in the
   *  error so the operator knows what to fix (e.g. `SUB_AGENT_MODEL`). */
  readonly configKey: string;
  /** A pinned concrete default for a class, consulted only when the live
   *  registry yields nothing for the provider (e.g. the host's offline seed). */
  readonly pinnedClassDefault?: (
    providerId: string,
    cls: ModelClass,
  ) => string | undefined;
}

/**
 * Resolve `ref` to a model id `providerId` can be sent — and NEVER return a
 * class ref (#1079).
 *
 *  - class ref → {@link resolveConfiguredModel} (the orchestrator's resolver:
 *    exact class, then nearest class, then any model of the provider); when the
 *    registry knows no model of the provider, `pinnedClassDefault`; when that
 *    has none either, throws {@link UnresolvedModelRefError}.
 *  - anything else → {@link coerceModelToProvider}, unchanged behaviour: an id
 *    the provider owns becomes its bare `modelId`, a cross-provider id becomes
 *    the provider's same-class model, an unknown/custom id passes through.
 */
export function resolveModelRefStrict(
  ref: string,
  providerId: string,
  opts: ResolveModelRefStrictOptions,
): string {
  const trimmed = ref.trim();
  if (!isClassRef(trimmed)) {
    const coerced = coerceModelToProvider(trimmed, providerId);
    if (!isClassRef(coerced)) return coerced;
    throw new UnresolvedModelRefError(trimmed, providerId, opts.configKey);
  }
  const cls = trimmed.slice('class:'.length) as ModelClass;
  const resolved =
    resolveConfiguredModel(trimmed, providerId) ??
    opts.pinnedClassDefault?.(providerId, cls);
  if (resolved === undefined || isClassRef(resolved)) {
    throw new UnresolvedModelRefError(trimmed, providerId, opts.configKey);
  }
  return resolved;
}
