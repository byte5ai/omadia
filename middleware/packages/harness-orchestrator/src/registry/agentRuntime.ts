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
