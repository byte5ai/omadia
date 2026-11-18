// Boot wiring for channel readiness and session capabilities (#2043): the hub
// over the two provider registries and the two per-plugin services. Works
// without a database (readiness and snapshots are asked live); only the
// pushes need message subscriptions and are delivered to nobody without them.

import type { ChannelReadinessProvider, MeetingSourceProvider } from '@omadia/channel-sdk';
import { isFacilitatorKind, type OrchestratorRegistry } from '@omadia/orchestrator';
import {
  CHANNEL_READINESS_SERVICE_NAME,
  SESSION_CAPABILITIES_SERVICE_NAME,
  perCallerService,
} from '@omadia/plugin-api';

import {
  resolveFacilitationEngine,
  type FacilitationEngineSources,
} from '../../platform/facilitatorGuard.js';
import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../../platform/serviceRegistry.js';
import type { ConversationMessageHub } from '../conversationMessages/hub.js';
import { principalOfChannelUser } from '../conversationMessages/wiring.js';
import { SessionCapabilityHub } from './hub.js';
import type { ChannelProviderRegistry } from './providerRegistry.js';
import {
  createChannelReadinessService,
  createSessionCapabilitiesService,
  type SessionServiceCaller,
} from './services.js';

export function wireSessionCapabilities(deps: {
  serviceRegistry: ServiceRegistry;
  readiness: ChannelProviderRegistry<ChannelReadinessProvider>;
  meetingSources: ChannelProviderRegistry<MeetingSourceProvider>;
  getRegistry: () => OrchestratorRegistry | undefined;
  /** Late-bound: the message hub exists only with a database. */
  getMessages: () => Pick<ConversationMessageHub, 'subscriptionsIn'> | undefined;
  engineSources: () => FacilitationEngineSources;
  log: (message: string) => void;
}): SessionCapabilityHub {
  const hub = new SessionCapabilityHub({
    readiness: deps.readiness,
    meetingSources: deps.meetingSources,
    identityFor: (slug, channelType) => deps.getRegistry()?.channelIdentityFor(slug, channelType),
    subscriptionsIn: (channelType, conversationId) =>
      deps.getMessages()?.subscriptionsIn(channelType, conversationId) ?? [],
    principalOf: principalOfChannelUser,
    log: deps.log,
  });
  const callerOf = (pluginId: string): SessionServiceCaller => ({
    callerPluginId: pluginId === KERNEL_SERVICE_CALLER.pluginId ? undefined : pluginId,
    isEngine: () => {
      const engine = resolveFacilitationEngine(deps.engineSources());
      return engine.state === 'bound' && engine.pluginId === pluginId;
    },
    isBoundFacilitator: (agentSlug) => {
      const entry = deps.getRegistry()?.get(agentSlug);
      return (
        entry !== undefined &&
        isFacilitatorKind(entry.agent) &&
        entry.plugins.some((p) => p.enabled && p.pluginId === pluginId)
      );
    },
  });
  deps.serviceRegistry.provide(
    CHANNEL_READINESS_SERVICE_NAME,
    perCallerService((caller) => createChannelReadinessService(hub, callerOf(caller.pluginId))),
  );
  deps.serviceRegistry.provide(
    SESSION_CAPABILITIES_SERVICE_NAME,
    perCallerService((caller) => createSessionCapabilitiesService(hub, callerOf(caller.pluginId))),
  );
  return hub;
}
