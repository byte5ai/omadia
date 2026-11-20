// The plugin-facing 'conversationMessages@2' service (#2043, #2089), one
// facade per calling plugin. Every human message of a group is the most
// sensitive thing a plugin can be handed, so every operation names a process
// and answers only for subscriptions the calling plugin created for it.

import type { ProcessConversationMessagesService, ProcessMessageScope } from '@omadia/plugin-api';

import type { AddressedMessageRouter } from '../addressedMessageRouter.js';
import type { PrivateMessageRouter } from '../privateMessageRouter.js';
import type { ConversationMessageHub } from './hub.js';

/**
 * The service for one calling plugin. There is no "is the engine" check
 * here: every operation is bound to a process, and a process is the caller's
 * only if the caller opened an execution scope for it, which only the plugin
 * that delivers the agent's archetype can (#2090).
 */
export function createProcessConversationMessagesService(deps: {
  readonly hub: ConversationMessageHub;
  /** `undefined` = the kernel itself, which runs no process. */
  readonly callerPluginId: string | undefined;
  /** #2089 — private messages of participants; absent: not offered. */
  readonly privateMessages?: Pick<PrivateMessageRouter, 'register'>;
  /** #2089 — who answers a message that addresses the agent; absent: not offered. */
  readonly addressedMessages?: Pick<AddressedMessageRouter, 'register'>;
}): ProcessConversationMessagesService {
  const { hub, callerPluginId } = deps;
  const router = deps.privateMessages;
  const addressed = deps.addressedMessages;
  return {
    ...(addressed && callerPluginId !== undefined
      ? {
          onAddressedMessage: (agentSlug: string, handler: Parameters<AddressedMessageRouter['register']>[2]) =>
            addressed.register(callerPluginId, agentSlug, handler),
        }
      : {}),
    ...(router && callerPluginId !== undefined
      ? {
          onPrivateMessage: (agentSlug: string, handler: Parameters<PrivateMessageRouter['register']>[2]) =>
            router.register(callerPluginId, agentSlug, handler),
        }
      : {}),
    async subscribe(scope: ProcessMessageScope, options) {
      if (callerPluginId === undefined) {
        return { outcome: 'refused', code: 'unavailable', message: 'only a plugin subscribes a process' };
      }
      return hub.subscribeProcess(scope, options?.mode, callerPluginId);
    },
    modeOf(scope) {
      return Promise.resolve(callerPluginId === undefined ? undefined : hub.modeOfProcess(scope, callerPluginId));
    },
    onMessage(agentSlug, handler) {
      if (callerPluginId === undefined) return () => undefined;
      return hub.onProcessMessage(agentSlug, callerPluginId, handler);
    },
    async getEvent(scope, messageId, revision) {
      return callerPluginId === undefined ? undefined : hub.getProcessEvent(scope, callerPluginId, messageId, revision);
    },
    async getEventById(scope, eventId) {
      return callerPluginId === undefined ? undefined : hub.getProcessEventById(scope, callerPluginId, eventId);
    },
    async listSince(scope, opts) {
      return callerPluginId === undefined ? { events: [] } : hub.listProcessEventsSince(scope, callerPluginId, opts);
    },
    async bindMessage(scope, ref) {
      return callerPluginId === undefined ? false : hub.bindProcessMessage(scope, callerPluginId, ref);
    },
  };
}
