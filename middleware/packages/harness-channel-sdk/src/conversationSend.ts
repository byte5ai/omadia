// Conversation-addressed proactive send (#330 C3b): post INTO a conversation
// (the group), as opposed to targetedSend's user-addressed DM. What the
// Facilitator's stall-nudges ride on. Same optional-capability discipline as
// every other B1 seam: a channel registers a provider, the kernel exposes a
// deny-by-default service over it, and unreachability is RETURNED, never
// thrown.

import type { TargetedDeliveryOutcome, TargetedMessage } from './targetedSend.js';

/**
 * Who the message is posted AS.
 *
 * A channel where several provisioned bots share one conversation has no
 * single "the bot": posting through whichever identity is handy makes one bot
 * say another's words under its own name and avatar, which nobody in the chat
 * can tell apart from the real thing. `asChannelKey` names the identity the
 * message MUST appear under — for Teams the bot key `28:<appId>`, the same
 * string inbound routing matches on.
 *
 * A provider that does not implement it ignores the option and keeps its
 * previous behaviour; a caller that needs the guarantee must therefore check
 * the outcome, not the absence of an error. A provider that DOES implement it
 * must return `unreachable` rather than silently substituting another
 * identity — a wrong sender is worse than no message.
 */
export interface ConversationSendOptions {
  /** Identity key the message must be sent as (Teams: `28:<appId>`). */
  asChannelKey?: string;
}

export interface ConversationSendProvider {
  /** The `channel_bindings.channel_type` this provider serves (e.g. 'teams'). */
  channelType: string;
  sendToConversation(
    conversationId: string,
    message: TargetedMessage,
    opts?: ConversationSendOptions,
  ): Promise<TargetedDeliveryOutcome>;
  /**
   * Show that this sender is composing — the chat client's "…" animation.
   *
   * Optional, and best-effort by contract: an activity indicator that fails is
   * never worth surfacing, let alone worth failing the work it was announcing.
   * A relayed conversation can leave twenty seconds of silence between turns
   * while an agent thinks, and to everyone watching that is indistinguishable
   * from nothing happening.
   *
   * Most clients dim the indicator after a few seconds, so a caller waiting
   * longer than that calls this repeatedly rather than once.
   */
  sendTyping?(conversationId: string, opts?: ConversationSendOptions): Promise<void>;
}
