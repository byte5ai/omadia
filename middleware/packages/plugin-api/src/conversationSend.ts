// Conversation-addressed proactive send (#330 C3b) — how an AGENT plugin
// (the Facilitator's stall-nudge) posts INTO a conversation, as opposed to
// targetedSend's user-addressed DM. Published by the kernel; plugins MUST
// treat it as optional and declare it as `optional_requires` (no plugin
// provides it — a hard `requires` would be unresolvable and keep the
// consumer from ever activating). Shapes are plugin-api-own on purpose
// (dependency direction: channel-sdk → plugin-api).

import type { ExecutionPhase, ExecutionPurpose, ExecutionRefusalCode } from './executionAuthorization.js';
import type { CardSupport, CardUpdate, CardUpdateOutcome, QuestionCard } from './questionCard.js';
import type { ChannelReadinessReport } from './sessionCapabilities.js';

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
  /** Several options may be chosen (an approval vote). Absent or `false` =
   *  one option. A channel that cannot offer several answers must not post a
   *  single-choice poll for it (one tap would replace a written multi-option
   *  ballot): it posts the question as text. An answer then carries
   *  `{ optionIds }` instead of `{ optionId }`. Kernels before this field
   *  drop it. */
  multipleAnswers?: boolean;
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
  /**
   * The agent can set a reaction on a message of the conversation as its own
   * identity (`ScopedConversationSendService.react`, spec 2043 §5.14). Absent
   * or false = the channel cannot; the caller then says nothing instead.
   */
  reactions?: boolean;
}

/**
 * A reaction an agent sets on somebody's message (spec 2043 §5.14: "recording
 * is quiet: a reaction where the channel supports it"). Named by what it
 * means, not by an emoji: each channel uses its own form of a thumbs-up
 * (Teams `like`, Slack `+1`, Discord and Telegram 👍).
 */
export type ConversationReaction = 'acknowledge';

/** Every reaction of {@link ConversationReaction}, for validation. */
export const CONVERSATION_REACTIONS: readonly ConversationReaction[] = ['acknowledge'];

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

// ---------------------------------------------------------------------------
// conversationSend@2 (#2091) — every send is an authorized action
// ---------------------------------------------------------------------------

/**
 * The second major: `ctx.services.get('conversationSend@2')`, declared as
 * `conversationSend@^2` under `optional_requires`.
 *
 * Every send, direct message, card update and readiness check names the
 * execution scope it is drawn from (#2090). The kernel takes the
 * authorization first: the target must be one the scope lists, the scope must
 * be open, inside its deadline and budget, and not stopped. Only then it
 * sends, as the agent's own identity as before (`no_identity` instead of
 * another bot).
 *
 * The target comes from the scope, not from a message subscription: a
 * `closing` scope still posts the protocol to a conversation whose
 * reservation was released.
 *
 * The kernel records which process a posted message and card belong to, so a
 * reply or a card answer reaches that process alone
 * (`conversationMessages@2`).
 */
export const CONVERSATION_SEND_V2_SERVICE_NAME = 'conversationSend@2';

/** The scope an action is drawn from, and what it is. */
export interface SendAuthorization {
  scopeId: string;
  processId: string;
  phase: ExecutionPhase;
  purpose: ExecutionPurpose;
  /** `prose`: text a model wrote (from an agent turn). `template`: text the
   *  engine filled into a template. */
  emission: 'prose' | 'template';
}

export type ScopedSendOutcome =
  /** `conversationId` is set on a delivered `sendDirect` when the channel
   *  reports the private conversation the message went into, so a later reply
   *  there can be matched to it. A conversation send never sets it. */
  | { outcome: 'delivered'; authorizationId: string; messageId?: string; cardMessageId?: string; conversationId?: string }
  | {
      outcome: 'unreachable';
      /** `not_authorized`: the execution authorization refused (see
       *  `executionCode`); nothing was sent. Otherwise the code of the first
       *  major (`no_identity`, `not_permitted`, `channel_error`, …). */
      code: string;
      message: string;
      executionCode?: ExecutionRefusalCode;
      /** Set when the action was authorized and the channel then failed: the
       *  action is spent. */
      authorizationId?: string;
    };

export interface ScopedConversationSendRequest {
  agentSlug: string;
  channelType: string;
  conversationId: string;
  message: ConversationSendRequest['message'];
  authorization: SendAuthorization;
}

export interface ScopedDirectSendRequest {
  agentSlug: string;
  channelType: string;
  /** `user:<id>`: the platform principal, as inbound events state it. It must
   *  be a person target of the scope AND a member or author of a conversation
   *  of the process. */
  principal: string;
  /** The recipient's channel reference when the caller knows it. */
  userRef?: { kind: string; id: string };
  message: { text: string };
  authorization: SendAuthorization;
}

export interface ScopedCardUpdateRequest extends ConversationCardUpdateRequest {
  authorization: SendAuthorization;
}

/**
 * Set a reaction on a message (spec 2043 §5.14), drawn from the scope like a
 * post to that conversation (action `post`, emission `data`). The message is
 * named by the kernel's id of its stored inbound event: the kernel reacts only
 * to a message it stored for this process in this conversation, never to one
 * of another conversation or process.
 */
export interface ScopedReactionRequest {
  agentSlug: string;
  channelType: string;
  conversationId: string;
  /** `ConversationMessageRecord.eventId` of the message to react to: a `created`
   *  or `edited` event (never a reaction or a card answer, whose `messageId` names
   *  another message). */
  messageEventId: string;
  reaction: ConversationReaction;
  /** `emission` is ignored: a reaction is recorded as `data`. */
  authorization: Omit<SendAuthorization, 'emission'> & { emission?: SendAuthorization['emission'] };
}

export type ScopedReactionOutcome =
  | { outcome: 'reacted'; authorizationId: string }
  | Extract<ScopedSendOutcome, { outcome: 'unreachable' }>;

export interface ScopedReadinessRequest {
  agentSlug: string;
  channelType: string;
  conversationId: string;
  /** `purpose` is `readiness_check`; no target: readiness is also checked for
   *  a conversation the process is about to link. */
  authorization: Omit<SendAuthorization, 'emission' | 'purpose'>;
}

export interface ScopedConversationSendService {
  sendToConversation(request: ScopedConversationSendRequest): Promise<ScopedSendOutcome>;
  sendToPerson(request: ScopedDirectSendRequest): Promise<ScopedSendOutcome>;
  updateCard(request: ScopedCardUpdateRequest): Promise<CardUpdateOutcome | Extract<ScopedSendOutcome, { outcome: 'unreachable' }>>;
  capabilities(channelType: string): ConversationSendCapabilities | undefined;
  /**
   * Set a reaction as the agent's own identity on a message of the
   * conversation (plugin-api 1.82.0). Only where `capabilities(channelType)`
   * says `reactions: true`; otherwise 'unreachable' with code
   * 'channel_error' and nothing is set. Optional member: absent on an older
   * kernel, feature-detect it.
   */
  react?(request: ScopedReactionRequest): Promise<ScopedReactionOutcome>;
  /**
   * Readiness of the agent's identity in ONE conversation: installed, may
   * read all messages where needed, can post. Asked when a conversation is
   * linked and again before a session goes live (spec 2043 §5.3).
   */
  checkReadiness(
    request: ScopedReadinessRequest,
  ): Promise<
    | { outcome: 'checked'; report: ChannelReadinessReport; authorizationId: string }
    | Extract<ScopedSendOutcome, { outcome: 'unreachable' }>
  >;
}
