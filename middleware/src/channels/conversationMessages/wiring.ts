// Boot wiring for 'conversationMessages@2' (#2043, #2089), kept out of `index.ts`:
// builds the hub over Postgres, publishes the per-plugin service and starts
// the retention job. Called once, from inside the database block.

import { archetypeAdds, conversationPrincipal } from '@omadia/orchestrator';
import type { Pool } from 'pg';

import { ReloadBus, type ConfigStore, type OrchestratorRegistry } from '@omadia/orchestrator';
import {
  CONVERSATION_MESSAGES_V2_SERVICE_NAME,
  perCallerService,
  type ChannelReadinessReport,
} from '@omadia/plugin-api';

import type { BotPresenceStore } from '../../conductor/botPresenceStore.js';
import type { FacilitationEngineSources } from '../../platform/facilitatorGuard.js';
import type { ObservedConversationInvites } from '../../platform/observedConversationInvites.js';
import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../../platform/serviceRegistry.js';
import type { AddressedMessageRouter } from '../addressedMessageRouter.js';
import type { LinkRequestRouter } from '../linkRequestRouter.js';
import type { PrivateMessageRouter } from '../privateMessageRouter.js';
import { PgOpenCardQuestionStore, type OpenCardQuestionStore } from '../openCardQuestions.js';
import { ConversationMessageHub, type ConversationMessageHubDeps } from './hub.js';
import { PgConversationMessageStore } from './pgStore.js';
import { startConversationMessagePurge, type ConversationMessagePurgeJob } from './purgeJob.js';
import { createProcessConversationMessagesService } from './service.js';
import { normalizeChannelKey, type MessageSubscription } from './store.js';

/** NOTIFY channel of the subscriptions table (migration 0068). */
export const SUBSCRIPTIONS_NOTIFY_CHANNEL = 'conversation_message_subscriptions_changed';

const TEAMS_BOT_KEY_PREFIX = '28:';

/**
 * Was this identity observed in the conversation?
 *
 * The invite index knows "a bot was added to this group" but not WHICH bot,
 * and it forgets after its TTL. Where the channel keeps per-bot conversation
 * references (Teams), those decide; the invite index is the fallback for a
 * channel without them and for a deployment whose reference table is empty.
 */
export function createBotPresenceCheck(deps: {
  invites: Pick<ObservedConversationInvites, 'get'>;
  botPresence?: Pick<BotPresenceStore, 'botAppIdsIn'>;
}): (channelType: string, conversationId: string, channelKey: string) => Promise<boolean> {
  return async (channelType, conversationId, channelKey) => {
    const key = normalizeChannelKey(channelKey);
    if (channelType === 'teams' && deps.botPresence && key.startsWith(TEAMS_BOT_KEY_PREFIX)) {
      const present = await deps.botPresence.botAppIdsIn(conversationId);
      if (present.length > 0) return present.includes(key.slice(TEAMS_BOT_KEY_PREFIX.length));
    }
    return deps.invites.get(channelType, conversationId) !== undefined;
  };
}

/**
 * The canonical principal of a channel user in a conversation: the
 * lower-cased channel user id (`conversationPrincipal`, ADR 0032), the same
 * helper the caller of a tool call is named by. It is derived, not looked
 * up, and it is the same value `targetedSend` takes.
 */
export function principalOfChannelUser(author: { readonly id: string }): string | undefined {
  return conversationPrincipal(author.id);
}

/**
 * Why a subscription has lost its ground, or `undefined` while it stands.
 *
 * Three things carry a subscription here: the plugin that made it is
 * running, the agent still exists and is enabled, and the agent still has the
 * identity the subscription was made for. Each is read from its source of
 * truth (installed registry, config store), not from the running registry: an
 * agent that merely failed to build keeps its subscription. Anything that
 * cannot be read right now answers `undefined`.
 *
 * The fourth, that the subscription's process still has an open execution
 * scope, is the hub's own check. Only the plugin that delivers the agent's
 * archetype can open one, so "is the caller that plugin" is not asked again
 * here; a plugin that was uninstalled had its scopes revoked.
 */
export function createSubscriptionGroundCheck(deps: {
  engineSources: () => FacilitationEngineSources;
  getConfigStore: () => Pick<ConfigStore, 'getAgentById' | 'listChannelIdentities'> | undefined;
}): (subscription: MessageSubscription) => Promise<string | undefined> {
  return async (subscription) => {
    const installed = deps
      .engineSources()
      .installedRegistry?.list()
      .find((entry) => entry.id === subscription.pluginId);
    if (installed && installed.status !== 'active') return `the plugin that subscribed is ${installed.status}`;
    const store = deps.getConfigStore();
    if (!store) return undefined;
    const agent = await store.getAgentById(subscription.agentId);
    if (!agent) return 'the agent was deleted';
    if (agent.status !== 'enabled') return 'the agent is disabled';
    if (!archetypeAdds(agent, 'conversation_messages')) return 'the agent is not a facilitator';
    const identities = await store.listChannelIdentities();
    const own = identities.find(
      (identity) => identity.agentId === agent.id && identity.channelType === subscription.channelType,
    );
    if (!own || normalizeChannelKey(own.channelKey) !== subscription.channelKey) {
      return `the agent no longer has the ${subscription.channelType} identity the subscription was made for`;
    }
    return undefined;
  };
}

export interface ConversationMessagesWiringDeps {
  readonly pool: Pool;
  readonly serviceRegistry: ServiceRegistry;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  readonly invites: Pick<ObservedConversationInvites, 'get'>;
  readonly botPresence?: Pick<BotPresenceStore, 'botAppIdsIn'>;
  readonly engineSources: () => FacilitationEngineSources;
  readonly getConfigStore: () => Pick<ConfigStore, 'getAgentById' | 'listChannelIdentities'> | undefined;
  /** LISTEN for subscription changes of other machines (one pooled
   *  connection). Off = the periodic reconcile alone. */
  readonly listen: boolean;
  /** Where LISTEN connects: Postgres directly, never a transaction-mode
   *  pooler. Absent = one connection of `pool`. */
  readonly listenConnectionString?: string;
  readonly reconcileIntervalMs: number;
  /** Late-bound: the readiness registry is wired after this block. */
  readonly checkReadiness?: (
    channelType: string,
    conversationId: string,
    channelKey: string,
  ) => Promise<ChannelReadinessReport | undefined>;
  readonly graceMs: number;
  readonly maxAgeDays: number;
  readonly purgeIntervalMs: number;
  /** #2089 — what a process may read, from the execution scopes and
   *  reservations. Absent: process subscriptions are not offered. */
  readonly processAccess?: ConversationMessageHubDeps['processAccess'];
  /** #2089 — where a plugin registers for private messages of participants. */
  readonly privateMessages?: Pick<PrivateMessageRouter, 'register'>;
  /** #2089 — where a plugin registers to decide turns that address its agent. */
  readonly addressedMessages?: Pick<AddressedMessageRouter, 'register' | 'owns'>;
  /** #2089 — where a plugin registers for link requests (spec 2043 §5.3). */
  readonly linkRequests?: Pick<LinkRequestRouter, 'register'>;
  readonly log: (message: string) => void;
}

export interface ConversationMessagesWiring {
  readonly hub: ConversationMessageHub;
  readonly store: PgConversationMessageStore;
  /** #2086 — the open questions of cards that went out as plain text (migration 0101). */
  readonly openQuestions: OpenCardQuestionStore;
  readonly purge: ConversationMessagePurgeJob;
  /**
   * Allow the kernel to END subscriptions whose ground is gone. Off until the
   * boot has activated the plugins: before that every plugin reads as not
   * active and every subscription would be ended at start.
   */
  enableReconcile(): void;
  /** Refresh from the table, then end what lost its ground (when enabled). */
  reconcileNow(): Promise<void>;
  stop(): Promise<void>;
}

export async function wireConversationMessages(
  deps: ConversationMessagesWiringDeps,
): Promise<ConversationMessagesWiring> {
  const store = new PgConversationMessageStore(deps.pool);
  const openQuestions = new PgOpenCardQuestionStore(deps.pool);
  const hub = new ConversationMessageHub({
    store,
    typedReplies: { store: openQuestions },
    resolveAgent: (slug) => deps.getRegistry()?.get(slug)?.agent,
    identityFor: (slug, channelType) => deps.getRegistry()?.channelIdentityFor(slug, channelType),
    isBotPresent: createBotPresenceCheck({
      invites: deps.invites,
      ...(deps.botPresence ? { botPresence: deps.botPresence } : {}),
    }),
    ...(deps.checkReadiness ? { checkReadiness: deps.checkReadiness } : {}),
    resolvePrincipal: (_channelType, author) => Promise.resolve(principalOfChannelUser(author)),
    groundFor: createSubscriptionGroundCheck({
      engineSources: deps.engineSources,
      getConfigStore: deps.getConfigStore,
    }),
    ...(deps.processAccess ? { processAccess: deps.processAccess } : {}),
    ...(deps.addressedMessages
      ? { ownsAddressedTurns: (pluginId: string, agentSlug: string) => deps.addressedMessages!.owns(pluginId, agentSlug) }
      : {}),
    log: deps.log,
  });
  let reconcileEnabled = false;
  const reconcileNow = async (): Promise<void> => {
    await hub.refresh();
    if (reconcileEnabled) await hub.reconcile();
  };
  try {
    await hub.refresh();
  } catch (err) {
    // A missing table (migration not applied yet) must not stop the boot; the
    // purge tick retries the refresh.
    deps.log(
      `[conversation-messages] subscriptions not loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // #2089 — every subscription and read is bound to a process. A plugin that
  // asks for the service by its bare name (the earlier form: one subscription
  // per agent and conversation, owned by "the engine") gets nothing.
  deps.serviceRegistry.provide(
    CONVERSATION_MESSAGES_V2_SERVICE_NAME,
    perCallerService((caller) =>
      createProcessConversationMessagesService({
        hub,
        callerPluginId: caller.pluginId === KERNEL_SERVICE_CALLER.pluginId ? undefined : caller.pluginId,
        ...(deps.privateMessages ? { privateMessages: deps.privateMessages } : {}),
        ...(deps.addressedMessages ? { addressedMessages: deps.addressedMessages } : {}),
        ...(deps.linkRequests ? { linkRequests: deps.linkRequests } : {}),
      }),
    ),
  );
  const purge = startConversationMessagePurge(store, {
    graceMs: deps.graceMs,
    maxAgeDays: deps.maxAgeDays,
    intervalMs: deps.purgeIntervalMs,
    log: deps.log,
  });
  // Every machine learns of a subscribe / unsubscribe through the table's
  // NOTIFY trigger (migration 0068); the periodic reconcile is the fallback
  // for a dropped LISTEN connection and where lost ground is noticed.
  const bus = new ReloadBus({
    pool: deps.pool,
    channel: SUBSCRIPTIONS_NOTIFY_CHANNEL,
    reload: reconcileNow,
    enableListen: deps.listen,
    ...(deps.listenConnectionString ? { listenConnectionString: deps.listenConnectionString } : {}),
    reconcileIntervalMs: deps.reconcileIntervalMs,
    log: (msg, fields) => {
      // The periodic line would be the loudest thing in the log.
      if (/periodic reconcile|reload applied/.test(msg)) return;
      deps.log(`[conversation-messages] ${msg}${fields ? ` ${JSON.stringify(fields)}` : ''}`);
    },
  });
  try {
    await bus.start();
  } catch (err) {
    deps.log(
      `[conversation-messages] LISTEN unavailable, relying on the periodic reconcile: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    hub,
    store,
    openQuestions,
    purge,
    enableReconcile: () => {
      reconcileEnabled = true;
    },
    reconcileNow,
    stop: async () => {
      purge.stop();
      await bus.stop();
    },
  };
}
