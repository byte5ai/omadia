// Conversation-addressed proactive send — the kernel service a plugin reaches
// as 'conversationSend'. Deliberately thin next to targetedDeliveryService: no
// principal resolution, one conversation, one delivery — and like every
// delivery path here, unreachability is a named outcome, never a throw.
//
// ONE scope (#2043): the message is posted as the agent's OWN bot
// (`asOwnIdentity`). No identity → `no_identity`, never another bot.
// Permission comes from the agent's message subscription for the
// conversation, held by the calling plugin.
//
// The earlier scope — an ephemeral attachment, posted through the channel's
// default bot (#330 C3b) — existed for the plugin-era facilitation and went
// with it. A call without `asOwnIdentity` is refused and says so. Agent
// discussions never used this service; they speak through `sayService`.

import type {
  CardUpdateOutcome,
  ConversationSendProvider,
  TargetedDeliveryOutcome,
  TargetedMessage,
} from '@omadia/channel-sdk';
import type { ConversationSendCapabilities } from '@omadia/plugin-api';

import type { ConversationSendRegistry } from './conversationSendRegistry.js';
import {
  markOwnIdentityMessage,
  readPoll,
  resolveMentions,
  unreachable,
  type OwnIdentityDeps,
} from './ownIdentitySend.js';
import { cardRefusalFor, readCardSupport, readCardUpdate, readQuestionCard } from './questionCard.js';

export interface ConversationSendInput {
  agentSlug: string;
  channelType: string;
  conversationId: string;
  /** `mentions[].user` may be the plugin form (a principal or channel user
   *  id as a string) or an already resolved channel user reference. */
  message: Omit<TargetedMessage, 'mentions' | 'poll' | 'card'> & {
    mentions?: readonly { user: unknown; text: string }[];
    poll?: unknown;
    /** #2089 — validated here; see `questionCard.ts`. */
    card?: unknown;
  };
  asOwnIdentity?: boolean;
}

export interface ConversationCardUpdateInput {
  agentSlug: string;
  channelType: string;
  conversationId: string;
  cardMessageId: string;
  update: unknown;
}

export interface ConversationSendService {
  /** `callerPluginId` is set by the per-plugin facade; absent = the kernel. */
  sendToConversation(input: ConversationSendInput, callerPluginId?: string): Promise<TargetedDeliveryOutcome>;
  /** #2089 — what the channel's plugin declares; `undefined` = no provider. */
  capabilities(channelType: string): ConversationSendCapabilities | undefined;
  /** #2089 — update a card the agent posted; same identity rules as a send. */
  updateCard(input: ConversationCardUpdateInput, callerPluginId?: string): Promise<CardUpdateOutcome>;
}

export function createConversationSendService(deps: {
  providers: ConversationSendRegistry;
  /** Own-identity sends. Absent (no registry) → every send is refused. */
  ownIdentity?: OwnIdentityDeps;
  /** Told about every message that went out as an agent's own identity. */
  onOwnIdentityDelivered?: (agentSlug: string, channelType: string, conversationId: string) => void;
  log?: (msg: string) => void;
}): ConversationSendService {
  const log = deps.log ?? (() => undefined);

  async function deliver(
    input: ConversationSendInput,
    message: TargetedMessage,
    asChannelKey: string,
  ): Promise<TargetedDeliveryOutcome> {
    const provider = deps.providers.get(input.channelType);
    if (!provider) {
      return unreachable(
        'channel_error',
        `no conversation-send provider registered for channel type '${input.channelType}'`,
      );
    }
    // The kernel cannot see whether a provider honoured `asChannelKey`: one
    // that predates the option ignores it and reports `delivered` through its
    // default bot. So only a provider that DECLARED it is asked.
    if (provider.supports?.asChannelKey !== true) {
      log(
        `[channels] own-identity send to ${input.channelType}/${input.conversationId} refused: the channel plugin does not declare supports.asChannelKey`,
      );
      return unreachable(
        'no_identity',
        `the '${input.channelType}' channel plugin does not declare that it sends as a named identity — nothing was posted, so nothing could go out under another bot's name`,
      );
    }
    if (message.poll && provider.supports.poll !== true) {
      return unreachable('channel_error', `the '${input.channelType}' channel plugin does not declare poll support`);
    }
    // A card only goes to a channel that declared every kind on it. The
    // refusal is a `channel_error` that says which, so the sender falls back
    // to a chat ballot instead of guessing.
    if (message.card) {
      const refusal = cardRefusalFor(message.card, readCardSupport(provider.supports.card), input.channelType);
      if (refusal) return unreachable('channel_error', `${refusal} — nothing was posted`);
    }
    // Mentions degrade by contract: a channel without them shows plain text.
    const { mentions, ...withoutMentions } = message;
    const marked = markOwnIdentityMessage(
      deps.ownIdentity?.disclosure,
      { agentSlug: input.agentSlug, channelType: input.channelType, target: input.conversationId },
      mentions && provider.supports.mentions !== true ? withoutMentions : message,
      provider.supports,
    );
    try {
      const outcome = await provider.sendToConversation(input.conversationId, marked.message, { asChannelKey });
      if (outcome.outcome === 'delivered') marked.delivered();
      return outcome;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      log(`[channels] conversation send to ${input.channelType}/${input.conversationId} threw: ${text}`);
      return unreachable('channel_error', text);
    }
  }

  async function sendAsOwnIdentity(
    input: ConversationSendInput,
    callerPluginId: string | undefined,
  ): Promise<TargetedDeliveryOutcome> {
    const own = deps.ownIdentity;
    const identity = own?.identityFor(input.agentSlug, input.channelType);
    if (!own || !identity) {
      return unreachable(
        'no_identity',
        `agent '${input.agentSlug}' has no ${input.channelType} identity of its own — it does not post through another agent's bot`,
      );
    }
    const subscription = own.subscriptions?.subscriptionFor({
      agentSlug: input.agentSlug,
      channelType: input.channelType,
      conversationId: input.conversationId,
    });
    if (!subscription || (callerPluginId !== undefined && subscription.pluginId !== callerPluginId)) {
      log(
        `[channels] own-identity send by '${input.agentSlug}' to ${input.channelType}/${input.conversationId} refused (no message subscription)`,
      );
      return unreachable(
        'not_permitted',
        `agent '${input.agentSlug}' holds no message subscription for this conversation — it only posts where it moderates`,
      );
    }
    let poll: TargetedMessage['poll'];
    if (input.message.poll !== undefined) {
      const read = readPoll(input.message.poll);
      if ('error' in read) return unreachable('channel_error', `invalid poll: ${read.error}`);
      poll = read.poll;
    }
    let card: TargetedMessage['card'];
    if (input.message.card !== undefined) {
      if (poll) return unreachable('channel_error', 'a message is a poll or a question card, not both');
      const read = readQuestionCard(input.message.card);
      if ('error' in read) return unreachable('channel_error', `invalid card: ${read.error}`);
      card = read.card;
    }
    const mentions = await resolveMentions(own, [subscription], input.message.mentions);
    const message: TargetedMessage = {
      text: input.message.text,
      ...(input.message.attachments ? { attachments: input.message.attachments } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(poll ? { poll } : {}),
      ...(card ? { card } : {}),
    };
    const outcome = await deliver(input, message, identity.channelKey);
    if (outcome.outcome === 'delivered') {
      deps.onOwnIdentityDelivered?.(input.agentSlug, input.channelType, input.conversationId);
    }
    return outcome;
  }

  /** Identity and subscription of an own-identity action, or the refusal. */
  function ownIdentityOf(
    scope: { agentSlug: string; channelType: string; conversationId: string },
    callerPluginId: string | undefined,
    action: string,
  ): { channelKey: string } | Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }> {
    const own = deps.ownIdentity;
    const identity = own?.identityFor(scope.agentSlug, scope.channelType);
    if (!own || !identity) {
      return unreachable(
        'no_identity',
        `agent '${scope.agentSlug}' has no ${scope.channelType} identity of its own — it does not post through another agent's bot`,
      ) as Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>;
    }
    const subscription = own.subscriptions?.subscriptionFor(scope);
    if (!subscription || (callerPluginId !== undefined && subscription.pluginId !== callerPluginId)) {
      log(
        `[channels] ${action} by '${scope.agentSlug}' in ${scope.channelType}/${scope.conversationId} refused (no message subscription)`,
      );
      return unreachable(
        'not_permitted',
        `agent '${scope.agentSlug}' holds no message subscription for this conversation — it only posts where it moderates`,
      ) as Extract<TargetedDeliveryOutcome, { outcome: 'unreachable' }>;
    }
    return { channelKey: identity.channelKey };
  }

  function capabilitiesOf(provider: ConversationSendProvider): ConversationSendCapabilities {
    const card = readCardSupport(provider.supports?.card);
    return {
      asOwnIdentity: provider.supports?.asChannelKey === true,
      mentions: provider.supports?.mentions === true,
      poll: provider.supports?.poll === true,
      // `update` is only true when the method is really there.
      ...(card ? { card: { ...card, update: card.update && typeof provider.updateCard === 'function' } } : {}),
    };
  }

  return {
    capabilities(channelType) {
      const provider = typeof channelType === 'string' ? deps.providers.get(channelType) : undefined;
      return provider ? capabilitiesOf(provider) : undefined;
    },

    async updateCard(input, callerPluginId) {
      const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
      if (
        !isText(input?.agentSlug, 128) ||
        !isText(input.channelType, 64) ||
        !isText(input.conversationId, 512) ||
        !isText(input.cardMessageId, 512)
      ) {
        return {
          outcome: 'unreachable',
          code: 'not_permitted',
          message: 'agentSlug, channelType, conversationId and cardMessageId are required',
        };
      }
      const scope = { agentSlug: input.agentSlug, channelType: input.channelType, conversationId: input.conversationId };
      const identity = ownIdentityOf(scope, callerPluginId, 'card update');
      if ('outcome' in identity) return identity;
      const provider = deps.providers.get(input.channelType);
      if (!provider) {
        return unreachable('channel_error', `no conversation-send provider registered for channel type '${input.channelType}'`) as CardUpdateOutcome;
      }
      // Same rule as a send: only a provider that DECLARED it acts as a named
      // identity is asked to act as the agent.
      if (provider.supports?.asChannelKey !== true) {
        return unreachable(
          'no_identity',
          `the '${input.channelType}' channel plugin does not declare that it sends as a named identity — nothing was updated`,
        ) as CardUpdateOutcome;
      }
      const support = capabilitiesOf(provider).card;
      if (!support?.update || !provider.updateCard) {
        return unreachable(
          'channel_error',
          `the '${input.channelType}' channel plugin cannot update a posted card — post the result as text`,
        ) as CardUpdateOutcome;
      }
      const read = readCardUpdate(input.update);
      if ('error' in read) return unreachable('channel_error', `invalid card update: ${read.error}`) as CardUpdateOutcome;
      if (read.update.state === 'open') {
        const refusal = cardRefusalFor(read.update.card, support, input.channelType);
        if (refusal) return unreachable('channel_error', `${refusal} — nothing was updated`) as CardUpdateOutcome;
      }
      try {
        return await provider.updateCard(input.conversationId, input.cardMessageId, read.update, {
          asChannelKey: identity.channelKey,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        log(`[channels] card update in ${input.channelType}/${input.conversationId} threw: ${text}`);
        return unreachable('channel_error', text) as CardUpdateOutcome;
      }
    },

    async sendToConversation(input, callerPluginId) {
      if (typeof input.agentSlug !== 'string' || input.agentSlug.trim().length === 0) {
        return { outcome: 'unreachable', code: 'not_permitted', message: 'agentSlug is required' };
      }
      if (input.asOwnIdentity === true) return sendAsOwnIdentity(input, callerPluginId);
      log(
        `[channels] conversation send by '${input.agentSlug}' to ${input.channelType}/${input.conversationId} refused (asOwnIdentity not set)`,
      );
      return {
        outcome: 'unreachable',
        code: 'not_permitted',
        message:
          'conversationSend posts as the agent\'s own identity only: set asOwnIdentity and hold a message subscription for the conversation',
      };
    },
  };
}
