/**
 * #1033 W2 — the per-agent model policy: parsing, validation, resolution.
 *
 * `agents.model_policy` (migration 0059) holds
 *
 *     { primary: 'auto' | ModelRef, fallback: 'none' | 'auto' | ModelRef }
 *
 * Three concerns live here so every reader agrees:
 *
 *   - {@link parseModelPolicy} narrows the persisted JSON deny-default: any
 *     shape the running code does not recognise reads as the DEFAULT
 *     (`auto` / `none`), which is today's behaviour — the safe direction for
 *     a rolling deploy or a hand-edited row.
 *   - {@link validateModelPolicy} is the WRITE-time gate: a ref must name a
 *     provider the host can serve (registered AND keyed), a catalogued model,
 *     and — if given — an effort that model declares; `fallback` must differ
 *     from `primary`. This REPLACES the old cross-provider rejection for the
 *     policy: primary and fallback may name different providers.
 *     A provider that cannot run a tool turn in-process (the subscription
 *     CLI, ADR-0086: it runs tool turns only as its own `run_loop`) is
 *     refused with {@link ModelPolicyRefusedError} (#1871).
 *   - {@link resolveModelPolicyRuntime} is what the registry applies when it
 *     builds an agent: an explicit primary pins the model (and effort) and
 *     switches triage off; `auto` leaves the three-tier resolution alone.
 *     With a provider pool the turn loop runs a primary on another provider
 *     there (W3); only a host without a pool defers it (effort only).
 *   - {@link describeModelPolicyRuntime} is the operator read-out: whether
 *     the primary is deferred (no pool) or currently unavailable (#1877).
 */

import type { EffortLevel, ModelInfo } from '@omadia/llm-provider';
import { EFFORT_LEVELS } from '@omadia/llm-provider';
import type { ModelPolicy, ModelRef } from '@omadia/plugin-api';

import { ConfigValidationError } from './configStore.js';

export const DEFAULT_MODEL_POLICY: ModelPolicy = { primary: 'auto', fallback: 'none' };

function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** A well-formed explicit ref, or undefined. */
export function parseModelRef(raw: unknown): ModelRef | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const provider = typeof rec['provider'] === 'string' ? rec['provider'].trim() : '';
  const model = typeof rec['model'] === 'string' ? rec['model'].trim() : '';
  if (provider.length === 0 || model.length === 0) return undefined;
  const effort = rec['effort'];
  if (effort !== undefined && !isEffort(effort)) return undefined;
  return { provider, model, ...(effort !== undefined ? { effort } : {}) };
}

export function isModelRef(v: ModelPolicy['primary'] | ModelPolicy['fallback']): v is ModelRef {
  return typeof v === 'object' && v !== null;
}

/** Deny-default narrowing of the persisted column. */
export function parseModelPolicy(raw: unknown): ModelPolicy {
  if (raw === null || typeof raw !== 'object') return DEFAULT_MODEL_POLICY;
  const rec = raw as Record<string, unknown>;
  const primary = rec['primary'] === 'auto' ? 'auto' : parseModelRef(rec['primary']);
  const fallbackRaw = rec['fallback'];
  const fallback =
    fallbackRaw === 'none' || fallbackRaw === 'auto' ? fallbackRaw : parseModelRef(fallbackRaw);
  if (primary === undefined || fallback === undefined) return DEFAULT_MODEL_POLICY;
  return { primary, fallback };
}

export function sameRef(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** What the validator needs to know about the host. */
export interface ModelPolicyValidationContext {
  /** The catalogue entry for `(provider, model)`, or undefined when unknown. */
  resolveModel(provider: string, model: string): ModelInfo | undefined;
  /** `true` iff the provider is registered AND has a key (or is keyless). */
  usable(provider: string): Promise<boolean>;
  /**
   * #1871 — `true` iff the provider can run an agent's tool turn in the
   * in-process loop. `false` for the subscription CLI (wire format
   * `claude-cli`): it answers only tool-less or forced single-tool requests.
   */
  runsToolTurns(provider: string): boolean;
}

/** #1871 — the machine-readable code of a refused policy ref. */
export const MODEL_POLICY_TOOL_INCOMPATIBLE = 'model_policy_tool_incompatible';

/**
 * #1871 — a policy the host must not run, with a code the UI localizes. The
 * operator route answers it with 400 and its `code`. Not a subclass of
 * `ConfigValidationError`: `configStore.ts` imports this module, so extending
 * its class here would read it before it is initialised.
 */
export class ModelPolicyRefusedError extends Error {
  constructor(
    readonly code: typeof MODEL_POLICY_TOOL_INCOMPATIBLE,
    message: string,
  ) {
    super(message);
    this.name = 'ModelPolicyRefusedError';
  }
}

async function validateRef(
  field: string,
  ref: ModelRef,
  ctx: ModelPolicyValidationContext,
): Promise<ModelInfo> {
  const info = ctx.resolveModel(ref.provider, ref.model);
  if (!info) {
    throw new ConfigValidationError(
      `${field}: model '${ref.model}' is not registered with provider '${ref.provider}'`,
    );
  }
  if (!ctx.runsToolTurns(ref.provider)) {
    throw new ModelPolicyRefusedError(
      MODEL_POLICY_TOOL_INCOMPATIBLE,
      `${field}: provider '${ref.provider}' cannot run an agent's tool turns (the subscription CLI answers only tool-less requests) — pick a provider with an API key`,
    );
  }
  if (!(await ctx.usable(ref.provider))) {
    throw new ConfigValidationError(
      `${field}: provider '${ref.provider}' has no API key configured — add one under Providers first`,
    );
  }
  if (ref.effort !== undefined) {
    const levels = info.effortLevels ?? [];
    if (!levels.includes(ref.effort)) {
      throw new ConfigValidationError(
        levels.length === 0
          ? `${field}: model '${ref.model}' declares no effort levels`
          : `${field}: effort '${ref.effort}' is not among the levels '${ref.model}' declares (${levels.join(', ')})`,
      );
    }
  }
  return info;
}

/** Vision capability of each explicit ref, for the DTO read-out. */
export interface ModelPolicyValidation {
  readonly primaryVision?: boolean;
  readonly fallbackVision?: boolean;
}

/**
 * Throws `ConfigValidationError` on the first violation. Returns the vision
 * capability of every explicit ref so the route can surface it — an operator
 * must see at write time that a fallback cannot serve an image turn.
 */
export async function validateModelPolicy(
  policy: ModelPolicy,
  ctx: ModelPolicyValidationContext,
): Promise<ModelPolicyValidation> {
  const out: { primaryVision?: boolean; fallbackVision?: boolean } = {};
  if (isModelRef(policy.primary)) {
    out.primaryVision = (await validateRef('primary', policy.primary, ctx)).vision;
  }
  if (isModelRef(policy.fallback)) {
    out.fallbackVision = (await validateRef('fallback', policy.fallback, ctx)).vision;
    if (isModelRef(policy.primary) && sameRef(policy.primary, policy.fallback)) {
      throw new ConfigValidationError('fallback must differ from primary');
    }
  }
  return out;
}

/** The runtime consequence of a policy for the registry build. */
export interface ResolvedModelPolicy {
  /** The pinned model id, when the primary is explicit AND on the active provider. */
  readonly model?: string;
  readonly effort?: EffortLevel;
  /** `true` when an explicit primary was set: triage does not apply. */
  readonly pinned: boolean;
  /**
   * The explicit primary names a provider other than the active one. Without
   * a provider pool only the effort applies; with one the turn loop runs the
   * primary there (`primaryRef`), see {@link describeModelPolicyRuntime}.
   */
  readonly deferredProvider?: string;
}

export function resolveModelPolicyRuntime(
  policy: ModelPolicy,
  activeProvider: string | undefined,
): ResolvedModelPolicy {
  if (!isModelRef(policy.primary)) return { pinned: false };
  const ref = policy.primary;
  const onActive = activeProvider === undefined || ref.provider === activeProvider;
  return {
    pinned: true,
    ...(onActive ? { model: ref.model } : { deferredProvider: ref.provider }),
    ...(ref.effort !== undefined ? { effort: ref.effort } : {}),
  };
}

/** What the operator read-out needs to know about the host. */
export interface ModelPolicyReadoutContext {
  readonly activeProvider?: string;
  /** A provider pool is wired: the turn loop switches providers itself (W3). */
  readonly switchesProviders: boolean;
  usable(provider: string): Promise<boolean>;
}

/** What the Model tab says about an explicit primary besides the policy. */
export interface ModelPolicyReadout {
  /** No provider pool: the primary's provider switch does not happen. */
  readonly deferredProvider?: string;
  /** #1877 — the primary's provider cannot be used now (no key, removed). */
  readonly primaryUnavailable?: string;
}

/**
 * #1871/#1877 — the read-out the route returns with a policy. `deferred` only
 * when the switch really does not happen (no pool); `primaryUnavailable` when
 * the provider has lost its key since the save, so the tab never claims a
 * model the turn cannot run on.
 */
export async function describeModelPolicyRuntime(
  policy: ModelPolicy,
  ctx: ModelPolicyReadoutContext,
): Promise<ModelPolicyReadout> {
  if (!isModelRef(policy.primary)) return {};
  const provider = policy.primary.provider;
  if (!(await ctx.usable(provider))) return { primaryUnavailable: provider };
  const deferred = resolveModelPolicyRuntime(policy, ctx.activeProvider).deferredProvider;
  return deferred !== undefined && !ctx.switchesProviders ? { deferredProvider: deferred } : {};
}
