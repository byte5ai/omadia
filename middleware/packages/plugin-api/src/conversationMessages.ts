// Authenticated inbound conversation messages ('conversationMessages@1',
// #2043): how an engine plugin (the facilitator) sees EVERY human message of a
// group conversation it moderates, with authorship it cannot make up.
//
// The kernel persists each inbound message event the channel emits for a
// subscribed conversation. Author, tenant, message id, revision and timestamp
// come from the channel adapter's platform event; a plugin reads the record by
// id and copies authorship from it. Nothing in this surface lets a model
// argument stand in for "who wrote this".
//
// Kernel-published, optional: declare it under `optional_requires` and
// feature-detect (older kernels and installs without Postgres do not have it).
// Shapes are plugin-api-own (dependency direction: channel-sdk -> plugin-api).

import type { SendAuthorization } from './conversationSend.js';
import type { CardAnswerValue } from './questionCard.js';

export const CONVERSATION_MESSAGES_SERVICE_NAME = 'conversationMessages';

export type ConversationMessageKind =
  | 'created'
  | 'edited'
  | 'deleted'
  | 'reaction'
  | 'card_answer'
  /** #2089 — what was said in a live session, as text from an authenticated
   *  media source ({@link MessageTranscriptSegment}). `messageId` is the segment id. */
  | 'transcript_segment';

export interface ConversationMessageAuthor {
  /** Channel-user namespace of the author (e.g. 'teams-aad'). */
  kind: string;
  /** Channel-native user id, as the platform stated it. */
  id: string;
  displayName?: string;
  /** Canonical principal ('user:<id>') when the kernel could resolve one. */
  principalId?: string;
}

/** One stored inbound event. Immutable once written; an edit is a new record
 *  with the same `messageId` and a higher `revision`. */
export interface ConversationMessageRecord {
  /** Kernel-assigned id of this stored event; also the replay cursor. */
  eventId: string;
  channelType: string;
  conversationId: string;
  /** Platform message id. For 'reaction' and 'card_answer' the id of the
   *  message reacted to / the card answered. */
  messageId: string;
  /** 0 for the original, incremented per edit as the platform reports it. */
  revision: number;
  kind: ConversationMessageKind;
  author: ConversationMessageAuthor;
  tenantId?: string;
  /** The bot identity that received the event (Teams: `28:<appId>`). */
  receivedByChannelKey: string;
  /** Plain text with mentions resolved; absent for 'deleted'. */
  text?: string;
  /** Set when the message replies to another one. */
  replyToMessageId?: string;
  /** The message quotes or forwards somebody else's text. A quoted ballot is
   *  not the quoting author's ballot. */
  quoted?: boolean;
  forwarded?: boolean;
  /** 'reaction': the reaction name and whether it was added or removed. */
  reaction?: { name: string; removed: boolean };
  /** 'card_answer': the card the kernel/plugin posted and the submitted value.
   *  `answererVerified` is `false` when the platform could not state who
   *  clicked (Teams: an anonymous meeting participant without an Entra id);
   *  such an answer must not count as that person's contribution. Absent =
   *  the channel made no statement (treat as verified by `author`). */
  cardAnswer?: MessageCardAnswer;
  /** ISO 8601, platform time of the event. */
  occurredAt: string;
  /** ISO 8601, when the kernel stored it. */
  receivedAt: string;
  /** #2089 — the channel stated that the message addresses the agent's bot
   *  (a mention). Absent = it did not say so. */
  addressedToBot?: boolean;
  /** 'transcript_segment': the session and the media source it came from.
   *  `text` is the transcribed text of this revision of the segment. */
  transcript?: MessageTranscriptSegment;
}

/**
 * #2089 (spec 2043 §5.3) — where a transcript segment comes from.
 *
 * `participant`: the platform delivered a media channel bound to one
 * participant's account; the record's `author` is that principal, and the
 * segment counts as their contribution only after they confirm exactly this
 * revision. `shared`: a room microphone or a mixed stream; nobody is the
 * author (the record's `author` names the media source: kind `custom`, id
 * `media:<source>`), `speakerHint` is a hint only, and a participant may adopt
 * exactly this revision by an authenticated message or card.
 */
export interface MessageTranscriptSegment {
  sessionId: string;
  /** Stable for the segment; equals the record's `messageId`. */
  segmentId: string;
  source: 'participant' | 'shared';
  /** Speaker recognition's guess. Never authorship. */
  speakerHint?: string;
}

export interface ConversationMessageScope {
  /** The subscribing agent's slug. Must be a facilitator-kind agent with its
   *  own identity on the channel. */
  agentSlug: string;
  channelType: string;
  conversationId: string;
}

export type ConversationMessageSubscribeOutcome =
  | { outcome: 'subscribed' }
  | {
      outcome: 'refused';
      /** 'no_identity': the agent has no own identity on this channel.
       *  'not_facilitator': the agent kind may not receive all messages.
       *  'not_present': the agent's bot was never observed in the conversation.
       *  'not_ready': the channel reported it cannot deliver all messages
       *  (see the readiness service for the precise reason). */
      code: 'no_identity' | 'not_facilitator' | 'not_present' | 'not_ready' | 'unavailable';
      message: string;
    };

export interface ConversationMessagePage {
  events: readonly ConversationMessageRecord[];
  /** Pass as `after` to continue; absent when the page reached the end. */
  nextCursor?: string;
}

export interface ConversationMessagesService {
  /** Start receiving every human message of the conversation for this agent.
   *  Idempotent. Persisted by the kernel, so it survives a plugin restart. */
  subscribe(scope: ConversationMessageScope): Promise<ConversationMessageSubscribeOutcome>;
  /** Stop receiving. Idempotent; the mention gate applies again at once. */
  unsubscribe(scope: ConversationMessageScope): Promise<void>;
  /** Live delivery of newly stored events for this agent's subscriptions.
   *  At-least-once: consumers dedupe on `eventId`. Returns a dispose handle. */
  onMessage(
    agentSlug: string,
    handler: (record: ConversationMessageRecord) => void | Promise<void>,
  ): () => void;
  /** The stored event for a message, latest revision unless one is named.
   *  `undefined` when the kernel never stored it for this subscription: a
   *  foreign conversation, a message from before the subscription, or an id
   *  that does not exist. */
  getEvent(
    scope: ConversationMessageScope,
    messageId: string,
    revision?: number,
  ): Promise<ConversationMessageRecord | undefined>;
  /** Replay stored events in order, for catching up after a restart. */
  listSince(
    scope: ConversationMessageScope,
    opts?: { after?: string; limit?: number },
  ): Promise<ConversationMessagePage>;
  /**
   * Does the caller hold an ACTIVE subscription for exactly this scope right
   * now? The exact form of what an engine otherwise has to infer from a
   * refused send or an empty replay: after its own restart, a revoked grant
   * or a disabled agent the kernel may have ended a subscription, and the
   * engine has to reconcile its live facilitations against that. Read from
   * the store, not from a cache, so it is right directly after boot. Answers
   * only for the caller's own subscriptions: `false` for another plugin's, for
   * a caller that is not the facilitation engine, and for an unknown scope.
   * Optional: absent on a kernel before plugin-api 1.56.0.
   */
  isSubscribed?(scope: ConversationMessageScope): Promise<boolean>;
}

/**
 * A submitted card or poll answer. For a poll: `value: { optionId }`. For a
 * question card (#2089): `answers`, one per answered question, plus the
 * proposal the card named. Everything except `author` of the event came back
 * through the client: check `cardId`, proposal id and version, question ids,
 * kinds and option ids against the card you sent, and drop what does not
 * match.
 */
export interface MessageCardAnswer {
  cardId: string;
  /** The raw submitted value. For a question card the channel repeats
   *  `{ answers }` here for readers that predate `answers`. */
  value: unknown;
  answererVerified?: boolean;
  proposalId?: string;
  proposalVersion?: number;
  answers?: readonly CardAnswerValue[];
}

// ---------------------------------------------------------------------------
// conversationMessages@2 (#2089) — reads and subscriptions bound to a process
// ---------------------------------------------------------------------------

/**
 * The second major: `ctx.services.get('conversationMessages@2')`, declared
 * as `conversationMessages@^2` under `optional_requires`.
 *
 * A subscription belongs to one PROCESS (a facilitation) and has a mode.
 * Every read names the process and returns only what that process received in
 * that conversation; a later process in the same conversation has its own
 * subscription and sees none of an earlier one's events.
 *
 * What the kernel requires (execution scopes and reservations, #2090):
 *  - `all`: the process holds the conversation's reservation and has an open
 *    execution scope;
 *  - `addressed`: the process has an open scope and holds or held the
 *    reservation;
 *  - when the reservation is released the kernel turns `all` into
 *    `addressed`; when the process has no open scope left it ends the
 *    subscription, and reads end with it.
 *
 * Which process an inbound message goes to is decided before it is stored:
 * a reply to a message, or an answer to a card, that is bound to a process
 * ({@link ProcessConversationMessagesService.bindMessage}) goes to that
 * process alone. Any other message goes to the process in `all` mode and,
 * when it addresses the agent, to every process in `addressed` mode.
 */
export const CONVERSATION_MESSAGES_V2_SERVICE_NAME = 'conversationMessages@2';

/** `all`: every human message. `addressed`: a mention, a reply to one of the
 *  process's messages, an answer to one of its cards. `none`: nothing is
 *  delivered; what was stored stays readable. */
export type ConversationMessageMode = 'all' | 'addressed' | 'none';

export interface ProcessMessageScope extends ConversationMessageScope {
  processId: string;
}

export interface ProcessConversationMessageRecord extends ConversationMessageRecord {
  processId: string;
}

export type ProcessSubscribeOutcome =
  | { outcome: 'subscribed'; mode: ConversationMessageMode }
  | {
      outcome: 'refused';
      code:
        | 'no_identity'
        | 'not_facilitator'
        | 'not_present'
        | 'not_ready'
        | 'unavailable'
        /** The mode needs the conversation's reservation and the process
         *  does not hold it (for `addressed`: never held it). */
        | 'not_reserved'
        /** The process has no open execution scope. */
        | 'no_scope'
        /** The process's subscription for this conversation has ended; a
         *  process subscribes a conversation once. */
        | 'ended';
      message: string;
    };

export interface ProcessConversationMessagesService {
  /** Subscribe the process to a conversation, or change the mode of its
   *  subscription. */
  subscribe(scope: ProcessMessageScope, options: { mode: ConversationMessageMode }): Promise<ProcessSubscribeOutcome>;
  /** The mode of the process's subscription; `undefined` when it has none or
   *  it has ended. */
  modeOf(scope: ProcessMessageScope): Promise<ConversationMessageMode | undefined>;
  /** Live delivery of the caller's process subscriptions of one agent. */
  onMessage(
    agentSlug: string,
    handler: (record: ProcessConversationMessageRecord) => void | Promise<void>,
  ): () => void;
  getEvent(scope: ProcessMessageScope, messageId: string, revision?: number): Promise<ProcessConversationMessageRecord | undefined>;
  getEventById(scope: ProcessMessageScope, eventId: string): Promise<ProcessConversationMessageRecord | undefined>;
  listSince(
    scope: ProcessMessageScope,
    opts?: { after?: string; limit?: number },
  ): Promise<{ events: readonly ProcessConversationMessageRecord[]; nextCursor?: string }>;
  /**
   * Tell the kernel that a message the agent sent (`messageId`) or a card it
   * posted (`cardId`) belongs to this process, so replies and answers reach
   * this process alone. `false`: it is already bound to another process, or
   * the process has no subscription here.
   */
  bindMessage(scope: ProcessMessageScope, ref: { messageId?: string; cardId?: string }): Promise<boolean>;
  /**
   * #2089 (spec 2043 §5.3) — private messages to the agent. Optional —
   * feature-detect.
   *
   * A message a person writes to the agent in a private chat reaches the
   * handler only when that person is a person target of an open execution
   * scope of one of the caller's processes of this agent. The handler decides
   * what it is: a status request it answers (`handled: true` with the text
   * and the scope the answer is drawn from), or nothing of the facilitation
   * (`handled: false`). The kernel takes the authorization for the answer
   * (a direct message to that person under that scope; a `status_only`
   * person gets a `status` answer only) and gives the text as the agent's
   * answer in that private chat. Declined, not authorized, or from anybody
   * else: the agent's ordinary answer to a private request, as before.
   */
  onPrivateMessage?(
    agentSlug: string,
    handler: (request: PrivateMessageRequest) => Promise<PrivateMessageReply>,
  ): () => void;

  /**
   * Who answers a message that ADDRESSES the agent in a group conversation
   * where one of the caller's processes listens in `addressed` mode (a
   * facilitation in follow-up)? Optional: absent on a kernel that predates
   * it.
   *
   * Without a handler such a mention has two takers: the agent's ordinary
   * turn (its model) and the process, which gets it as an event. With a
   * handler the kernel asks it first and exactly one of them answers:
   * `handled: true` and the agent's turn stays silent, the process answers
   * through its own sends; `handled: false` and the agent's ordinary turn
   * runs, as if no process listened.
   *
   * What changes for `onMessage` once a handler is registered for the agent:
   * a plain message that addresses the agent is still stored for the
   * caller's `addressed` subscriptions (readable with `getEvent` and
   * `listSince`, usable as the inbound event of an agent turn), but it is no
   * longer pushed to `onMessage`. Replies and card answers bound to a process
   * are pushed as before. A consumer that also reads with `listSince`
   * dedupes on `eventId`.
   *
   * The handler must decide quickly and do its work after it returned: the
   * kernel waits 20 seconds, then lets the agent's ordinary turn answer. A
   * handler that answers later than that produces a second answer.
   */
  onAddressedMessage?(
    agentSlug: string,
    handler: (request: AddressedMessageRequest) => Promise<AddressedMessageReply>,
  ): () => void;
}

export interface AddressedMessageRequest {
  agentSlug: string;
  channelType: string;
  /** The channel-native conversation, as on the processes' subscriptions. */
  conversationId: string;
  /** The author's platform id, as the turn states it (compare lower-cased). */
  principalId: string;
  text: string;
  /** The platform id of the message, when the channel states it on the turn. */
  messageId?: string;
  /** The stored event of that message for one of `processIds`, when the
   *  channel states the message id and the event had been stored by the time
   *  the turn arrived. Absent otherwise; it can still arrive in `listSince`. */
  eventId?: string;
  /** The caller's processes of this agent that listen in `addressed` mode in
   *  this conversation. Never empty. */
  processIds: readonly string[];
}

export interface AddressedMessageReply {
  /** `true`: a process takes the message and the agent's turn stays silent. */
  handled: boolean;
}

export interface PrivateMessageRequest {
  agentSlug: string;
  channelType: string;
  /** The author's platform id, as the turn states it (compare lower-cased). */
  principalId: string;
  text: string;
  /** The caller's processes of this agent whose open scopes list the author.
   *  Several: the handler asks which one is meant, or answers for each. */
  processIds: readonly string[];
}

export type PrivateMessageReply =
  | { handled: false }
  | {
      handled: true;
      /** The answer, given in the private chat as the agent. */
      text: string;
      /** The scope the answer is drawn from; `purpose` is `status` for a
       *  status answer. */
      authorization: SendAuthorization;
    };
