// Boot wiring for 'conversationMessages@1' (#2043), kept out of `index.ts`:
// builds the hub over Postgres, publishes the per-plugin service and starts
// the retention job. Called once, from inside the database block.

import type { Pool } from 'pg';

import { formatPrincipal, makePrincipal } from '@omadia/channel-sdk';
import type { OrchestratorRegistry } from '@omadia/orchestrator';
import {
  CONVERSATION_MESSAGES_SERVICE_NAME,
  perCallerService,
  type ChannelReadinessReport,
} from '@omadia/plugin-api';

import type { BotPresenceStore } from '../../conductor/botPresenceStore.js';
import {
  resolveFacilitationEngine,
  type FacilitationEngineSources,
} from '../../platform/facilitatorGuard.js';
import type { ObservedConversationInvites } from '../../platform/observedConversationInvites.js';
import { KERNEL_SERVICE_CALLER, type ServiceRegistry } from '../../platform/serviceRegistry.js';
import { ConversationMessageHub } from './hub.js';
import { PgConversationMessageStore } from './pgStore.js';
import { startConversationMessagePurge, type ConversationMessagePurgeJob } from './purgeJob.js';
import { createConversationMessagesService } from './service.js';
import { normalizeChannelKey } from './store.js';

/** Service the orchestrator asks whether the engine drives a conversation. */
export const FACILITATOR_CONVERSATIONS_SERVICE = 'facilitatorConversations';

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
 * The canonical principal of a channel user. In this kernel a user principal
 * IS the lower-cased channel user id (`makePrincipal`, the same rule the
 * Teams adapter applies to a turn's `userId`), so it is derived, not looked
 * up — and it is the same value `targetedSend` takes.
 */
export function principalOfChannelUser(author: { readonly id: string }): string | undefined {
  const principal = makePrincipal('user', author.id);
  return principal ? formatPrincipal(principal) : undefined;
}

export interface ConversationMessagesWiringDeps {
  readonly pool: Pool;
  readonly serviceRegistry: ServiceRegistry;
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  readonly invites: Pick<ObservedConversationInvites, 'get'>;
  readonly botPresence?: Pick<BotPresenceStore, 'botAppIdsIn'>;
  readonly engineSources: () => FacilitationEngineSources;
  /** Late-bound: the readiness registry is wired after this block. */
  readonly checkReadiness?: (
    channelType: string,
    conversationId: string,
    channelKey: string,
  ) => Promise<ChannelReadinessReport | undefined>;
  readonly graceMs: number;
  readonly maxAgeDays: number;
  readonly purgeIntervalMs: number;
  readonly log: (message: string) => void;
}

export interface ConversationMessagesWiring {
  readonly hub: ConversationMessageHub;
  readonly store: PgConversationMessageStore;
  readonly purge: ConversationMessagePurgeJob;
}

export async function wireConversationMessages(
  deps: ConversationMessagesWiringDeps,
): Promise<ConversationMessagesWiring> {
  const store = new PgConversationMessageStore(deps.pool);
  const hub = new ConversationMessageHub({
    store,
    resolveAgent: (slug) => deps.getRegistry()?.get(slug)?.agent,
    identityFor: (slug, channelType) => deps.getRegistry()?.channelIdentityFor(slug, channelType),
    isBotPresent: createBotPresenceCheck({
      invites: deps.invites,
      ...(deps.botPresence ? { botPresence: deps.botPresence } : {}),
    }),
    ...(deps.checkReadiness ? { checkReadiness: deps.checkReadiness } : {}),
    resolvePrincipal: (_channelType, author) => Promise.resolve(principalOfChannelUser(author)),
    log: deps.log,
  });
  try {
    await hub.refresh();
  } catch (err) {
    // A missing table (migration not applied yet) must not stop the boot; the
    // purge tick retries the refresh.
    deps.log(
      `[conversation-messages] subscriptions not loaded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  deps.serviceRegistry.provide(
    CONVERSATION_MESSAGES_SERVICE_NAME,
    perCallerService((caller) => {
      const isKernel = caller.pluginId === KERNEL_SERVICE_CALLER.pluginId;
      return createConversationMessagesService({
        hub,
        callerPluginId: isKernel ? undefined : caller.pluginId,
        isEngine: () => {
          const engine = resolveFacilitationEngine(deps.engineSources());
          return engine.state === 'bound' && engine.pluginId === caller.pluginId;
        },
      });
    }),
  );
  // Asked by the orchestrator on every group turn of a facilitator: once the
  // engine receives the conversation's messages, it drives every turn there.
  deps.serviceRegistry.provide(
    FACILITATOR_CONVERSATIONS_SERVICE,
    (agentSlug: string, channelType: string, conversationId: string): boolean =>
      hub.subscriptionFor({ agentSlug, channelType, conversationId }) !== undefined,
  );

  const purge = startConversationMessagePurge(store, hub, {
    graceMs: deps.graceMs,
    maxAgeDays: deps.maxAgeDays,
    intervalMs: deps.purgeIntervalMs,
    log: deps.log,
  });
  return { hub, store, purge };
}
