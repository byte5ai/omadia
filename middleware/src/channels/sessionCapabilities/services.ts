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
}

const NOT_ENGINE = 'only the facilitation engine plugin may use this service';

export function createChannelReadinessService(
  hub: SessionCapabilityHub,
  caller: SessionServiceCaller,
): ChannelReadinessService {
  const allowed = (): boolean => caller.callerPluginId === undefined || caller.isEngine();
  return {
    async check(request) {
      if (!allowed()) {
        return {
          ready: false,
          installed: false,
          canReadAllMessages: false,
          canPost: false,
          missing: [{ code: 'unsupported_conversation', message: NOT_ENGINE }],
        };
      }
      return hub.check(request);
    },
    async repairConsent(request) {
      if (!allowed()) return { outcome: 'failed', code: 'unsupported', message: NOT_ENGINE };
      return hub.repairConsent(request);
    },
  };
}

export function createSessionCapabilitiesService(
  hub: SessionCapabilityHub,
  caller: SessionServiceCaller,
): SessionCapabilitiesService {
  const allowed = (): boolean => caller.callerPluginId === undefined || caller.isEngine();
  return {
    async getSnapshot(request) {
      // The baseline is no secret; a caller that is not the engine gets it
      // without the channel being asked.
      if (!allowed()) return hub.baseline(request.channelType, request.conversationId, request.sessionRef);
      return hub.getSnapshot(request);
    },
    onChange(agentSlug, handler) {
      if (!allowed()) return () => undefined;
      return hub.onSnapshot(agentSlug, caller.callerPluginId, handler);
    },
    onSessionEvent(agentSlug, handler) {
      if (!allowed()) return () => undefined;
      return hub.onSessionEvent(agentSlug, caller.callerPluginId, handler);
    },
  };
}
