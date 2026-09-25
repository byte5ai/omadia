import {
  resolveConfiguredModel,
  resolveModelIdForProvider,
} from '@omadia/llm-provider';

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

// A CLASS ref, not a model id: the registry resolves it to whatever the
// active provider currently serves as its fast model (live-discovered or
// seed), so this default never goes stale when a vendor ships a new
// generation. `validateModelRef` accepts class refs.
const DEFAULT_CLASSIFIER_MODEL = 'class:fast';

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
 * A CLASS ref, deliberately not a model id: `resolveConfiguredModel` turns it
 * into the active provider's current frontier model at build time, so the
 * platform default follows the live catalog instead of a hard-coded version.
 * Kept in sync with `ORCHESTRATOR_MODEL` (middleware/src/config.ts).
 */
export const DEFAULT_ORCHESTRATOR_MODEL = 'class:frontier';

/**
 * The configured-model resolvers live in `@omadia/llm-provider` since #1079 so
 * the dynamic sub-agents, the verifier, the orchestrator-extras and plugin
 * `ctx.llm` call the IDENTICAL function the orchestrator uses. Re-exported here
 * to keep every existing import path working.
 */
export { resolveConfiguredModel, resolveModelIdForProvider };

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
