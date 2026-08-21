// Conversation-addressed proactive send (#330 C3b): post INTO a conversation
// (the group), as opposed to targetedSend's user-addressed DM. What the
// Facilitator's stall-nudges ride on. Same optional-capability discipline as
// every other B1 seam: a channel registers a provider, the kernel exposes a
// deny-by-default service over it, and unreachability is RETURNED, never
// thrown.

import type { TargetedDeliveryOutcome, TargetedMessage } from './targetedSend.js';

export interface ConversationSendProvider {
  /** The `channel_bindings.channel_type` this provider serves (e.g. 'teams'). */
  channelType: string;
  sendToConversation(conversationId: string, message: TargetedMessage): Promise<TargetedDeliveryOutcome>;
}
