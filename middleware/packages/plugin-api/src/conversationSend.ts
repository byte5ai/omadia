// Conversation-addressed proactive send (#330 C3b) — how an AGENT plugin
// (the Facilitator's stall-nudge) posts INTO a conversation, as opposed to
// targetedSend's user-addressed DM. Published by the kernel; plugins MUST
// treat it as optional and declare it as `optional_requires` (no plugin
// provides it — a hard `requires` would be unresolvable and keep the
// consumer from ever activating). Shapes are plugin-api-own on purpose
// (dependency direction: channel-sdk → plugin-api).

export const CONVERSATION_SEND_SERVICE_NAME = 'conversationSend';

export interface ConversationSendRequest {
  /** The calling agent's slug — attribution AND scope key: the kernel only
   *  delivers into conversations this agent holds an ephemeral attachment
   *  for (its own auto-bound facilitations). Everything else is a named
   *  'not_permitted' outcome — a granted plugin cannot post into arbitrary
   *  or foreign conversations. */
  agentSlug: string;
  /** The `channel_bindings.channel_type` to deliver on (e.g. 'teams'). */
  channelType: string;
  /** Channel-native conversation id (the group chat). */
  conversationId: string;
  message: {
    text: string;
  };
}

export type ConversationSendOutcome =
  | { outcome: 'delivered' }
  | { outcome: 'unreachable'; code: string; message: string };

export interface ConversationSendService {
  sendToConversation(request: ConversationSendRequest): Promise<ConversationSendOutcome>;
}
