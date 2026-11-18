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
    /** People to @mention. Each `text` must occur in `message.text`; the
     *  channel turns that occurrence into a real mention. Ignored by channels
     *  without mentions. */
    mentions?: readonly ConversationSendMention[];
    /** Post the message as a poll (#2043). A channel without polls answers
     *  'unreachable' rather than posting the question as plain text. Each
     *  answer arrives as a `card_answer` message event with
     *  `cardAnswer: { cardId: pollId, value: { optionId } }`. */
    poll?: SendPoll;
  };
  /** Post as the agent's OWN channel identity (#2043). The kernel resolves the
   *  agent's bot and refuses with code 'no_identity' when it has none; it
   *  never falls back to another bot. Permission then comes from the agent's
   *  message subscription for the conversation ('conversationMessages@1')
   *  instead of an ephemeral attachment. */
  asOwnIdentity?: boolean;
}

/** A poll to post. `delivered.messageId` is the poll's message; a changed
 *  answer is a second event and the consumer decides which one counts. */
export interface SendPoll {
  /** 1..128 characters; comes back as `cardAnswer.cardId` with every answer. */
  pollId: string;
  question: string;
  /** 2..6 options with unique ids (1..128 characters each). */
  options: readonly { id: string; label: string }[];
  /** Optional line under the question. */
  hint?: string;
}

export interface ConversationSendMention {
  /** Canonical principal ('user:<id>') or channel-native user id. The kernel
   *  resolves it to the channel's user reference from the conversation's
   *  roster and stored messages; a person it cannot find stays plain text. */
  user: string;
  /** The display text standing in `message.text` (e.g. '@Anna Köhler'). */
  text: string;
}

export type ConversationSendOutcome =
  /** `messageId` is the platform id of the posted message when the channel
   *  reports one. A poll may go out as two messages (text, then card):
   *  `cardMessageId` is the card and the `messageId` of every `card_answer`
   *  event for it. */
  | { outcome: 'delivered'; messageId?: string; cardMessageId?: string }
  | { outcome: 'unreachable'; code: string; message: string };

export interface ConversationSendService {
  sendToConversation(request: ConversationSendRequest): Promise<ConversationSendOutcome>;
}
