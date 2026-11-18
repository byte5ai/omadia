// Publishes 'targetedSend' and 'conversationSend' as PER-CALLER services
// (#2043). Both keep the plugin-facing shape they always had; the facade only
// adds what a plugin cannot be trusted to state itself — which plugin is
// calling. An own-identity send is permitted by a message subscription, and
// a subscription belongs to the plugin that created it.

import { perCallerService } from '@omadia/plugin-api';

import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../platform/serviceRegistry.js';
import type { ConversationSendService } from './conversationSendService.js';
import type { TargetedDeliveryService } from './targetedDeliveryService.js';

type SendInput<T extends (...args: never[]) => unknown> = Parameters<T>[0];

export function publishSendServices(deps: {
  serviceRegistry: ServiceRegistry;
  targeted: TargetedDeliveryService;
  conversation: ConversationSendService;
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
  deps.serviceRegistry.provide(
    'conversationSend',
    perCallerService((caller) => ({
      sendToConversation: (input: SendInput<ConversationSendService['sendToConversation']>) =>
        deps.conversation.sendToConversation(input, callerPluginId(caller.pluginId)),
    })),
  );
}
