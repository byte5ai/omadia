// Conversation-addressed proactive send (#330 C3b) — how an AGENT plugin
// (the Facilitator's stall-nudge) posts INTO a conversation, as opposed to
// targetedSend's user-addressed DM. Published by the kernel; plugins MUST
// treat it as optional and declare it as `optional_requires` (no plugin
// provides it — a hard `requires` would be unresolvable and keep the
// consumer from ever activating). Shapes are plugin-api-own on purpose
// (dependency direction: channel-sdk → plugin-api).

import type { CardSupport, CardUpdate, CardUpdateOutcome, QuestionCard } from './questionCard.js';

export const CONVERSATION_SEND_SERVICE_NAME = 'conversationSend';

export interface ConversationSendRequest {
  /** The agent to post as — attribution AND scope key: the kernel only
   *  delivers into conversations this agent holds a message subscription for
   *  ('conversationMessages@1'). Everything else is a named 'not_permitted'
   *  outcome — a plugin cannot post into arbitrary or foreign conversations. */
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
    /** Post the message as a question card (#2089). Refused with
     *  'channel_error' when the channel declares no card support, does not
     *  list one of the question kinds, or the card is invalid; nothing is
     *  posted then, so fall back to a chat ballot. Ask
     *  `capabilities(channelType)` first. Not together with `poll`. Each
     *  submission arrives as a `card_answer` message event with
     *  `cardAnswer.answers`. `delivered.cardMessageId` is the id for
     *  `updateCard`. */
    card?: QuestionCard;
  };
  /** Post as the agent's OWN channel identity (#2043). The kernel resolves the
   *  agent's bot and refuses with code 'no_identity' when it has none; it
   *  never falls back to another bot. REQUIRED in effect: since the
   *  plugin-era facilitation was removed, a request without it is refused
   *  with 'not_permitted' (the field stays optional in the type so older
   *  callers keep compiling). */
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

/** What a channel can do with a conversation send, as its plugin declared it. */
export interface ConversationSendCapabilities {
  /** Posts as an agent's own identity; without it no own-identity send works. */
  asOwnIdentity: boolean;
  mentions: boolean;
  poll: boolean;
  /** Absent = no question cards on this channel. */
  card?: CardSupport;
}

export interface ConversationCardUpdateRequest {
  /** The agent that posted the card. Same rules as a send: its own identity,
   *  and a message subscription for the conversation held by the caller. */
  agentSlug: string;
  channelType: string;
  conversationId: string;
  /** `delivered.cardMessageId` of the send that posted the card. */
  cardMessageId: string;
  update: CardUpdate;
}

export interface ConversationSendService {
  sendToConversation(request: ConversationSendRequest): Promise<ConversationSendOutcome>;
  /**
   * What the channel of `channelType` declares (#2089). `undefined` = no
   * channel plugin serves that type. Optional member: absent on a kernel
   * older than plugin-api 1.59.0, where no channel has cards.
   */
  capabilities?(channelType: string): ConversationSendCapabilities | undefined;
  /**
   * Update a card the agent posted (#2089): close it with the result, or
   * replace it with a corrected open card. The update goes out as the agent's
   * own identity; a channel only updates a message that identity posted.
   * 'unreachable' with code 'channel_error' when the channel cannot update
   * cards or the update is invalid, 'no_identity' / 'not_permitted' as for a
   * send. Optional member: feature-detect it.
   */
  updateCard?(request: ConversationCardUpdateRequest): Promise<CardUpdateOutcome>;
}
