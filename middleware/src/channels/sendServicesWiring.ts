// Publishes 'targetedSend' and 'conversationSend' as PER-CALLER services
// (#2043). Both keep the plugin-facing shape they always had; the facade only
// adds what a plugin cannot be trusted to state itself — which plugin is
// calling. An own-identity send is permitted by a message subscription, and
// a subscription belongs to the plugin that created it.

import {
  CONVERSATION_SEND_V2_SERVICE_NAME,
  perCallerService,
  type ExecutionAuthorizationService,
} from '@omadia/plugin-api';

import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../platform/serviceRegistry.js';
import type { ConversationSendService } from './conversationSendService.js';
import { sendDirectAsOwnIdentity, type OwnIdentityDirectSendDeps } from './ownIdentityDirectSend.js';
import { createScopedSendService, type ScopedSendServiceDeps } from './scopedSendService.js';
import type { TargetedDeliveryService } from './targetedDeliveryService.js';

type SendInput<T extends (...args: never[]) => unknown> = Parameters<T>[0];

export function publishSendServices(deps: {
  serviceRegistry: ServiceRegistry;
  targeted: TargetedDeliveryService;
  conversation: ConversationSendService;
  /** #2091 — what 'conversationSend@2' needs beyond the first major's
   *  services. Absent: the second major is not published. */
  scoped?: {
    executionFor: (pluginId: string) => ExecutionAuthorizationService | undefined;
    direct: OwnIdentityDirectSendDeps;
    messages?: () => ScopedSendServiceDeps['messages'];
    readiness?: ScopedSendServiceDeps['readiness'];
    log?: (message: string) => void;
  };
}): void {
  const callerPluginId = (pluginId: string): string | undefined =>
    pluginId === KERNEL_SERVICE_CALLER.pluginId ? undefined : pluginId;

  deps.serviceRegistry.provide(
    'targetedSend',
    perCallerService((caller) => ({
      sendToPrincipal: (input: SendInput<TargetedDeliveryService['sendToPrincipal']>) =>
        deps.targeted.sendToPrincipal(input, callerPluginId(caller.pluginId)),
    })),
  );
  // #2091 — a post into a conversation is drawn from an execution scope
  // (`conversationSend@2`). The first major, permitted by a message
  // subscription without a process, is no longer provided since K6.
  // `targetedSend` above has one major and stays.
  const scoped = deps.scoped;
  if (!scoped) return;
  deps.serviceRegistry.provide(
    CONVERSATION_SEND_V2_SERVICE_NAME,
    perCallerService((caller) => {
      const messages = scoped.messages?.();
      return createScopedSendService({
        // The kernel runs no process: with an empty id no scope is its own.
        callerPluginId: callerPluginId(caller.pluginId) ?? '',
        execution: () => scoped.executionFor(caller.pluginId),
        conversation: deps.conversation,
        direct: async (input, subscriptions) => {
          const report = await sendDirectAsOwnIdentity(scoped.direct, input, caller.pluginId, { subscriptions });
          const delivery = report.deliveries[0]?.outcome;
          if (delivery) return delivery;
          const diagnostic = report.diagnostics[0];
          return {
            outcome: 'unreachable',
            code: 'channel_error',
            message: diagnostic ? `${diagnostic.code}: ${diagnostic.message}` : 'the message could not be sent',
          };
        },
        ...(messages ? { messages } : {}),
        ...(scoped.readiness ? { readiness: scoped.readiness } : {}),
        ...(scoped.log ? { log: scoped.log } : {}),
      });
    }),
  );
}
