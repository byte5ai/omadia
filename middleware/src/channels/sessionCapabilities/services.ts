// The plugin-facing 'channelReadiness' and 'sessionCapabilities' services
// (#2043), one facade per calling plugin. Like the message record, they
// answer the instance's facilitation engine only: readiness and repair act on
// an agent's own identity, and pushes follow the engine's subscriptions.

import type {
  ChannelReadinessService,
  SessionCapabilitiesService,
} from '@omadia/plugin-api';

import type { SessionCapabilityHub } from './hub.js';

export interface SessionServiceCaller {
  /** `undefined` for the kernel itself. */
  readonly callerPluginId: string | undefined;
  readonly isEngine: () => boolean;
  /**
   * Is this agent a facilitator the calling engine is granted to? The same
   * binding `conversationMessages.subscribe` and `agentTurn` require: an
   * engine learns nothing about (and repairs nothing for) a standard agent's
   * bot, nor a facilitator it does not run. Not asked for the kernel itself.
   */
  readonly isBoundFacilitator: (agentSlug: string) => boolean;
}

const NOT_ENGINE = 'only the facilitation engine plugin may use this service';
const NOT_BOUND = 'the agent is not a facilitator bound to the calling engine';

function permitted(caller: SessionServiceCaller, agentSlug: unknown): string | undefined {
  if (caller.callerPluginId === undefined) return undefined;
  if (!caller.isEngine()) return NOT_ENGINE;
  if (typeof agentSlug !== 'string' || !caller.isBoundFacilitator(agentSlug)) return NOT_BOUND;
  return undefined;
}

export function createChannelReadinessService(
  hub: SessionCapabilityHub,
  caller: SessionServiceCaller,
): ChannelReadinessService {
  return {
    async check(request) {
      const refusal = permitted(caller, request?.agentSlug);
      if (refusal !== undefined) {
        return {
          ready: false,
          installed: false,
          canReadAllMessages: false,
          canPost: false,
          missing: [{ code: 'unsupported_conversation', message: refusal }],
        };
      }
      return hub.check(request);
    },
    async repairConsent(request) {
      const refusal = permitted(caller, request?.agentSlug);
      if (refusal !== undefined) return { outcome: 'failed', code: 'unsupported', message: refusal };
      return hub.repairConsent(request);
    },
  };
}

export function createSessionCapabilitiesService(
  hub: SessionCapabilityHub,
  caller: SessionServiceCaller,
): SessionCapabilitiesService {
  // Pushes are decided at DELIVERY, like live messages: a plugin that stops
  // being the engine, or an agent that stops being its facilitator, gets
  // nothing more; registering early is harmless.
  const mayReceive = (agentSlug: string) => (): boolean => permitted(caller, agentSlug) === undefined;
  return {
    async getSnapshot(request) {
      // The baseline is no secret; anybody else gets it without the channel
      // being asked.
      if (permitted(caller, request?.agentSlug) !== undefined) {
        return hub.baseline(request.channelType, request.conversationId, request.sessionRef);
      }
      return hub.getSnapshot(request);
    },
    onChange(agentSlug, handler) {
      return hub.onSnapshot(agentSlug, caller.callerPluginId, handler, mayReceive(agentSlug));
    },
    onSessionEvent(agentSlug, handler) {
      return hub.onSessionEvent(agentSlug, caller.callerPluginId, handler, mayReceive(agentSlug));
    },
  };
}
