// GET /api/v1/operator/agents/facilitation-engine (#2043) — what the
// Facilitators directory needs to say "the engine is not set up": which
// plugin is the instance's facilitation engine (by manifest capability) and
// whether it reports itself usable.
//
// The engine plugin publishes a small state object under the service name
// `facilitationEngine`: `{ pluginId, version, available, unavailableReason? }`
// (`available: false` = no SQL grant / no Postgres). The kernel reads it; it
// never guesses a plugin id.

import type { Request, Response } from 'express';

import { FACILITATION_ENGINE_CAPABILITY } from '@omadia/plugin-api';

import {
  resolveFacilitationEngine,
  type FacilitationEngineSources,
} from '../platform/facilitatorGuard.js';

/** Registry key of the engine's state service (the capability without `@1`). */
export const FACILITATION_ENGINE_SERVICE_NAME =
  FACILITATION_ENGINE_CAPABILITY.split('@')[0] ?? 'facilitationEngine';

export type FacilitationEngineState =
  /** Exactly one engine plugin is installed. */
  | 'bound'
  /** No installed plugin provides the capability. */
  | 'none'
  /** More than one does; nothing can be granted until one is removed. */
  | 'ambiguous';

export interface FacilitationEngineStatusBody {
  readonly state: FacilitationEngineState;
  readonly capability: string;
  /** The engine plugin when `state` is `bound`, else `null`. */
  readonly plugin_id: string | null;
  /** Every installed provider; more than one entry only when `ambiguous`. */
  readonly plugin_ids: readonly string[];
  readonly version: string | null;
  /** The engine can run facilitations right now. */
  readonly available: boolean;
  /** Why not, in the operator's terms; `null` when available. */
  readonly unavailable_reason: string | null;
}

interface EngineServiceState {
  pluginId?: unknown;
  version?: unknown;
  available?: unknown;
  unavailableReason?: unknown;
}

export function facilitationEngineStatus(
  sources: FacilitationEngineSources,
  reported: unknown,
): FacilitationEngineStatusBody {
  const engine = resolveFacilitationEngine(sources);
  const base = { capability: FACILITATION_ENGINE_CAPABILITY, version: null };
  if (engine.state === 'none') {
    return {
      ...base,
      state: 'none',
      plugin_id: null,
      plugin_ids: [],
      available: false,
      unavailable_reason: 'No facilitation engine plugin is installed.',
    };
  }
  if (engine.state === 'ambiguous') {
    return {
      ...base,
      state: 'ambiguous',
      plugin_id: null,
      plugin_ids: engine.pluginIds,
      available: false,
      unavailable_reason: 'More than one facilitation engine plugin is installed; remove all but one.',
    };
  }
  const service = (reported ?? null) as EngineServiceState | null;
  // Only the bound plugin's own report counts.
  const own = service !== null && service.pluginId === engine.pluginId ? service : null;
  const available = own?.available === true;
  return {
    state: 'bound',
    capability: FACILITATION_ENGINE_CAPABILITY,
    plugin_id: engine.pluginId,
    plugin_ids: [engine.pluginId],
    version: typeof own?.version === 'string' ? own.version : null,
    available,
    unavailable_reason: available
      ? null
      : own === null
        ? 'The facilitation engine plugin is installed but not active.'
        : typeof own.unavailableReason === 'string' && own.unavailableReason.trim().length > 0
          ? own.unavailableReason
          : 'The facilitation engine reports that it is not set up.',
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
