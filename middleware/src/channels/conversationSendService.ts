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

import type { TargetedDeliveryOutcome, TargetedMessage } from '@omadia/channel-sdk';

import type { ConversationSendRegistry } from './conversationSendRegistry.js';
import {
  readPoll,
  resolveMentions,
  unreachable,
  type OwnIdentityDeps,
} from './ownIdentitySend.js';

export interface ConversationSendInput {
  agentSlug: string;
  channelType: string;
  conversationId: string;
  /** `mentions[].user` may be the plugin form (a principal or channel user
   *  id as a string) or an already resolved channel user reference. */
  message: Omit<TargetedMessage, 'mentions' | 'poll'> & {
    mentions?: readonly { user: unknown; text: string }[];
    poll?: unknown;
  };
  asOwnIdentity?: boolean;
}

export interface ConversationSendService {
  /** `callerPluginId` is set by the per-plugin facade; absent = the kernel. */
  sendToConversation(input: ConversationSendInput, callerPluginId?: string): Promise<TargetedDeliveryOutcome>;
}

export function createConversationSendService(deps: {
  providers: ConversationSendRegistry;
  /** Own-identity sends. Absent (no registry) → every send is refused. */
  ownIdentity?: OwnIdentityDeps;
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
    try {
      return await provider.sendToConversation(input.conversationId, message, { asChannelKey });
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
    const mentions = await resolveMentions(own, [subscription], input.message.mentions);
    const message: TargetedMessage = {
      text: input.message.text,
      ...(input.message.attachments ? { attachments: input.message.attachments } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(poll ? { poll } : {}),
    };
    return deliver(input, message, identity.channelKey);
  }

  return {
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
