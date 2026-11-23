// GET /api/v1/operator/agents/facilitation-engine (#2043) — what the
// Facilitators directory needs to say "the engine is not set up": which
// plugin is (or wants to be) the instance's facilitation engine and whether
// facilitations can run.
//
// The answer carries CODES, not sentences: the web-ui puts the reason into a
// translated sentence of its own. The only free text is what the engine
// plugin itself reports (`engine_reason`).
//
// The engine plugin publishes a small state object under the service name
// `facilitationEngine`: `{ pluginId, version, available, unavailableReason? }`
// (`available: false` = no Postgres / migrations not run). The kernel reads
// it; it never guesses a plugin id.

import type { Request, Response } from 'express';

import {
  facilitationEnginePluginIds,
  type FacilitationEngineSources,
} from '../platform/facilitatorGuard.js';
import {
  engineUsability,
  type EngineUnusableReason,
} from '../platform/facilitatorRuntimeService.js';

/** Registry key of the state object the engine plugin publishes about
 *  itself. A plugin declares it under `provides` (`facilitationEngine@1`) to
 *  be allowed to publish it; that line no longer makes it the engine. */
export const FACILITATION_ENGINE_SERVICE_NAME = 'facilitationEngine';

export type FacilitationEngineState =
  /** One installed archetype plugin delivers the archetype `facilitator`. */
  | 'bound'
  /** None does. */
  | 'none'
  /** More than one does; nothing takes effect until one is removed. */
  | 'ambiguous';

export interface FacilitationEngineStatusBody {
  readonly state: FacilitationEngineState;
  /** The engine plugin (`bound`), else `null`. */
  readonly plugin_id: string | null;
  /** Every installed plugin that delivers the archetype. */
  readonly plugin_ids: readonly string[];
  readonly version: string | null;
  /** Facilitations can be run right now. */
  readonly available: boolean;
  /**
   * Why not, as a code; `null` when available.
   * `none` | `ambiguous` | `inactive` (installed, not started) |
   * `not_reported` (active, but it published no state) | `engine_reported`
   * (the engine says it is not ready; see `engine_reason`).
   */
  readonly reason_code: EngineUnusableReason | null;
  /** The engine plugin's own explanation, untranslated; `null` otherwise. */
  readonly engine_reason: string | null;
}

export function facilitationEngineStatus(
  sources: FacilitationEngineSources,
  reported: unknown,
): FacilitationEngineStatusBody {
  const usability = engineUsability(sources, reported);
  const declared = facilitationEnginePluginIds(sources);
  const state: FacilitationEngineState =
    usability.reason === 'none' || usability.reason === 'ambiguous'
      ? usability.reason
      : 'bound';
  return {
    state,
    plugin_id: usability.pluginId ?? null,
    plugin_ids: declared,
    version: usability.version ?? null,
    available: usability.usable,
    reason_code: usability.reason ?? null,
    engine_reason: usability.engineReason ?? null,
  };
}

export function createFacilitationEngineStatusHandler(deps: {
  sources: () => FacilitationEngineSources;
  /** The engine's published state object, or `undefined`. */
  reported: () => unknown;
}): (req: Request, res: Response) => void {
  return (_req, res) => {
    res.json(facilitationEngineStatus(deps.sources(), deps.reported()));
  };
}
