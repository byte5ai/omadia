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

export const CONVERSATION_MESSAGES_SERVICE_NAME = 'conversationMessages';

export type ConversationMessageKind =
  | 'created'
  | 'edited'
  | 'deleted'
  | 'reaction'
  | 'card_answer';

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
  /** 'card_answer': the card the kernel/plugin posted and the submitted value. */
  cardAnswer?: { cardId: string; value: unknown };
  /** ISO 8601, platform time of the event. */
  occurredAt: string;
  /** ISO 8601, when the kernel stored it. */
  receivedAt: string;
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
}
