// The plugin-facing 'conversationMessages' service (#2043), one facade per
// calling plugin. Every human message of a group is the most sensitive thing
// a plugin can be handed, so the facade answers only the instance's
// facilitation engine (found by manifest capability, see
// `platform/facilitatorGuard.ts`) and only for subscriptions that plugin
// created itself. Any other caller gets a service that refuses and is empty.

import type {
  ConversationMessageScope,
  ConversationMessagesService,
  ProcessConversationMessagesService,
  ProcessMessageScope,
} from '@omadia/plugin-api';

import type { ConversationMessageHub } from './hub.js';

export interface ConversationMessagesServiceDeps {
  readonly hub: ConversationMessageHub;
  /** The calling plugin's id; `undefined` for the kernel itself. */
  readonly callerPluginId: string | undefined;
  /** Is the caller the instance's facilitation engine right now? Asked per
   *  call: an engine can be installed or removed while the process runs. */
  readonly isEngine: () => boolean;
}

export function createConversationMessagesService(
  deps: ConversationMessagesServiceDeps,
): ConversationMessagesService {
  const { hub, callerPluginId } = deps;
  const allowed = (): boolean => callerPluginId === undefined || deps.isEngine();
  return {
    async subscribe(scope: ConversationMessageScope) {
      if (!allowed() || callerPluginId === undefined) {
        return {
          outcome: 'refused',
          code: 'unavailable',
          message: 'only the facilitation engine plugin may subscribe to conversation messages',
        };
      }
      return hub.subscribe(scope, callerPluginId);
    },
    async unsubscribe(scope) {
      if (!allowed()) return;
      await hub.unsubscribe(scope, callerPluginId);
    },
    onMessage(agentSlug, handler) {
      // Always registered, decided at DELIVERY: only records of the caller's
      // own subscriptions reach the handler, and only while the caller is the
      // engine. A plugin that registers before it is bound starts receiving
      // once it is; one that stops being the engine receives nothing more.
      return hub.onMessage(agentSlug, callerPluginId, handler, allowed);
    },
    async getEvent(scope, messageId, revision) {
      if (!allowed()) return undefined;
      return hub.getEvent(scope, callerPluginId, messageId, revision);
    },
    async isSubscribed(scope) {
      if (!allowed() || callerPluginId === undefined) return false;
      return hub.holdsSubscription(scope, callerPluginId);
    },
    async listSince(scope, opts) {
      if (!allowed()) return { events: [] };
      return hub.listSince(scope, callerPluginId, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// conversationMessages@2 (#2089)
// ---------------------------------------------------------------------------

/**
 * The second major for one calling plugin. There is no "is the engine" check
 * here: every operation is bound to a process, and a process is the caller's
 * only if the caller opened an execution scope for it, which only the plugin
 * that delivers the agent's archetype can (#2090).
 */
export function createProcessConversationMessagesService(deps: {
  readonly hub: ConversationMessageHub;
  /** `undefined` = the kernel itself, which runs no process. */
  readonly callerPluginId: string | undefined;
}): ProcessConversationMessagesService {
  const { hub, callerPluginId } = deps;
  return {
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
