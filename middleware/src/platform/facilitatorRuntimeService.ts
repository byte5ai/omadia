// What the orchestrator asks the kernel about a facilitator at turn time
// (#2043), published as `facilitatorConversations`:
//
//   isEngineDriven  the engine holds the agent's message subscription for the
//                   conversation, so it drives every turn there and a
//                   channel-started turn is suppressed;
//   isEngineUsable  a facilitation can actually be run for this agent. If
//                   not, a facilitator says that facilitation is not set up
//                   and does nothing else (spec 2043 §0) instead of reaching
//                   a model that has no tool to act with.
//
// "Usable" is every link of the chain, each read where it is true: one plugin
// declares the capability AND the operator granted it SQL (bound), it is
// active, it reports itself available (its own state object: Postgres and
// grant in place), and it is granted to this agent.

import type { FacilitatorRuntimeLookup, OrchestratorRegistry } from '@omadia/orchestrator';

import type { ConversationMessageHub } from '../channels/conversationMessages/hub.js';
import {
  resolveFacilitationEngine,
  type FacilitationEngineSources,
} from './facilitatorGuard.js';

/** Service name; the orchestrator plugin declares it under `optional_requires`. */
export const FACILITATOR_CONVERSATIONS_SERVICE = 'facilitatorConversations';

export type EngineUnusableReason =
  | 'none'
  | 'ambiguous'
  | 'ungranted'
  | 'inactive'
  | 'not_reported'
  | 'engine_reported';

export interface EngineUsability {
  readonly usable: boolean;
  readonly pluginId?: string;
  /** Why not; absent when usable. */
  readonly reason?: EngineUnusableReason;
  /** The engine's own words, when `reason` is `engine_reported`. */
  readonly engineReason?: string;
  readonly version?: string;
}

interface ReportedEngineState {
  pluginId?: unknown;
  version?: unknown;
  available?: unknown;
  unavailableReason?: unknown;
}

/** The instance-wide answer: is there an engine that can run facilitations? */
export function engineUsability(sources: FacilitationEngineSources, reported: unknown): EngineUsability {
  const engine = resolveFacilitationEngine(sources);
  if (engine.state === 'none') return { usable: false, reason: 'none' };
  if (engine.state === 'ambiguous') return { usable: false, reason: 'ambiguous' };
  if (engine.state === 'ungranted') return { usable: false, pluginId: engine.pluginId, reason: 'ungranted' };
  const { pluginId } = engine;
  const installed = sources.installedRegistry?.list().find((entry) => entry.id === pluginId);
  if (installed && installed.status !== 'active') return { usable: false, pluginId, reason: 'inactive' };
  const state = (reported ?? null) as ReportedEngineState | null;
  // Only the bound plugin's own report counts.
  const own = state !== null && state.pluginId === pluginId ? state : null;
  const version = typeof own?.version === 'string' ? own.version : undefined;
  if (own === null) return { usable: false, pluginId, reason: 'not_reported' };
  if (own.available !== true) {
    const text = typeof own.unavailableReason === 'string' ? own.unavailableReason.trim() : '';
    return {
      usable: false,
      pluginId,
      reason: 'engine_reported',
      ...(text.length > 0 ? { engineReason: text } : {}),
      ...(version !== undefined ? { version } : {}),
    };
  }
  return { usable: true, pluginId, ...(version !== undefined ? { version } : {}) };
}

export function createFacilitatorRuntimeLookup(deps: {
  getRegistry: () => OrchestratorRegistry | undefined;
  getMessages: () => Pick<ConversationMessageHub, 'subscriptionFor'> | undefined;
  engineSources: () => FacilitationEngineSources;
  /** The state object the engine plugin publishes, or `undefined`. */
  reportedEngineState: () => unknown;
}): FacilitatorRuntimeLookup {
  return {
    isEngineDriven: (agentSlug, channelType, conversationId) =>
      deps.getMessages()?.subscriptionFor({ agentSlug, channelType, conversationId }) !== undefined,
    isEngineUsable: (agentSlug) => {
      const usability = engineUsability(deps.engineSources(), deps.reportedEngineState());
      if (!usability.usable) return false;
      const entry = deps.getRegistry()?.get(agentSlug);
      return entry?.plugins.some((p) => p.enabled && p.pluginId === usability.pluginId) === true;
    },
  };
}
