// Conversation-addressed proactive send (#330 C3b) — the kernel service a
// granted agent plugin reaches as 'conversationSend'. Deliberately thin next
// to targetedDeliveryService: no principal resolution, one conversation, one
// delivery — and like every delivery path here, unreachability is a named
// outcome, never a throw.
//
// Two scopes, chosen by the caller:
//
//   - default (#330): the calling agent holds an EPHEMERAL ATTACHMENT for the
//     conversation and the channel posts as it always did. Unchanged; the
//     discussion relay and the pre-1.0 facilitation run on it.
//   - `asOwnIdentity` (#2043): the message is posted as the agent's OWN bot.
//     No identity → `no_identity`, never another bot. Permission comes from
//     the agent's message subscription for the conversation, held by the
//     calling plugin.

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
  /** Scope authority (review H1): true iff the calling agent holds an
   *  ephemeral attachment for this conversation (its own auto-bound
   *  facilitation). Absent (no database) → FAIL CLOSED: without a scope
   *  authority nobody gets to post into groups proactively. */
  isPermitted?: (agentSlug: string, channelType: string, conversationId: string) => Promise<boolean>;
  /** #2043 — own-identity sends. Absent → `asOwnIdentity` is refused. */
  ownIdentity?: OwnIdentityDeps;
  log?: (msg: string) => void;
}): ConversationSendService {
  const log = deps.log ?? (() => undefined);

  async function deliver(
    input: ConversationSendInput,
    message: TargetedMessage,
    asChannelKey?: string,
  ): Promise<TargetedDeliveryOutcome> {
    const provider = deps.providers.get(input.channelType);
    if (!provider) {
      return unreachable(
        'channel_error',
        `no conversation-send provider registered for channel type '${input.channelType}'`,
      );
    }
    try {
      return asChannelKey === undefined
        ? await provider.sendToConversation(input.conversationId, message)
        : await provider.sendToConversation(input.conversationId, message, { asChannelKey });
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

      const permitted = deps.isPermitted
        ? await deps.isPermitted(input.agentSlug, input.channelType, input.conversationId).catch(() => false)
        : false;
      if (!permitted) {
        log(`[channels] conversation send by '${input.agentSlug}' to ${input.channelType}/${input.conversationId} refused (no owned ephemeral attachment)`);
        return {
          outcome: 'unreachable',
          code: 'not_permitted',
          message: `agent '${input.agentSlug}' holds no ephemeral attachment for this conversation — proactive group posting is scoped to own facilitations`,
        };
      }
      // Unchanged: the message goes to the provider exactly as it was given.
      return deliver(input, input.message as TargetedMessage);
    },
  };
}
