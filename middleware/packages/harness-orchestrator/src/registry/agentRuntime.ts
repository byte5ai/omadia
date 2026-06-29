import { resolveModelRef } from '@omadia/llm-provider';

import type { ModelRoutingConfig as RuntimeModelRouting } from '../modelRouter.js';

/**
 * Map an agent's persisted `model_routing` JSON (the Agent Builder / plugin-api
 * shape `{ mode, main, triage?, simple?, escalateOn? }`) onto the orchestrator
 * runtime knobs:
 *
 *   - a `model` override (the agent's chosen primary model), and
 *   - an optional `modelRouting` ({classifierModel, simpleModel, complexModel})
 *     when the operator picked per-turn `triage` routing.
 *
 * Pure + defensive: unknown / malformed JSON yields `{}` (the registry falls
 * back to the platform default runtime config). Lives in the orchestrator
 * package so the persisted-shape→runtime-shape bridge has one home and is
 * unit-testable without a DB.
 */

const DEFAULT_CLASSIFIER_MODEL = 'claude-haiku-4-5';

/**
 * Hard fallback orchestrator model — the last tier of the per-instance model
 * resolution (issue #296 AC#2):
 *
 *   1. the Agent's own `model_routing.main` (operator's per-instance choice)
 *   2. the global seeded platform default (`orchestrator_model` install config,
 *      itself seeded from the `ORCHESTRATOR_MODEL` env in middleware/src/config.ts)
 *   3. this constant — so an empty / misconfigured platform default never yields
 *      an empty model id (which would 404 on every turn).
 *
 * Must be a currently-served model id, kept in sync with `ORCHESTRATOR_MODEL`
 * (middleware/src/config.ts) and the plugin's install-config fallback.
 */
export const DEFAULT_ORCHESTRATOR_MODEL = 'claude-opus-4-8';

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

export interface ResolvedAgentRuntime {
  /** Primary model override (the agent's `main`), if set. */
  readonly model?: string;
  /** Per-turn routing config, only when mode is 'triage' with a usable `main`. */
  readonly modelRouting?: RuntimeModelRouting;
}

export function resolveAgentModelRouting(
  raw: Record<string, unknown> | null | undefined,
): ResolvedAgentRuntime {
  if (!raw || typeof raw !== 'object') return {};

  const mode = raw['mode'];
  const main = typeof raw['main'] === 'string' ? (raw['main'] as string) : undefined;
  if (!main) return {};

  if (mode === 'single') {
    return { model: main };
  }

  if (mode === 'triage') {
    const triage =
      typeof raw['triage'] === 'string'
        ? (raw['triage'] as string)
        : DEFAULT_CLASSIFIER_MODEL;
    const simple =
      typeof raw['simple'] === 'string' ? (raw['simple'] as string) : main;
    return {
      model: main,
      modelRouting: {
        classifierModel: triage,
        simpleModel: simple,
        complexModel: main,
      },
    };
  }

  // Unknown mode — still honour the chosen primary model.
  return { model: main };
}
