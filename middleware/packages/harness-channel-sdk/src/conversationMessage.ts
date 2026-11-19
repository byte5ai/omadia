// Inbound conversation messages (#2043): the channel adapter tells the kernel
// about EVERY human message in a conversation an agent moderates, including
// the ones that do not mention the bot, plus edits, deletions, reactions and
// card answers. The kernel stores them as the authoritative record of who
// wrote what ('conversationMessages@1' in plugin-api).
//
// This is not a turn. Emitting a message event starts no model call; the
// consumer decides whether one follows. Mentioned messages keep going through
// the normal turn path AND are emitted here when the conversation is
// subscribed, so the record has no gaps.

import type { MessageCardAnswer } from '@omadia/plugin-api';

import type { ConversationMessageKind, MessageTranscriptSegment } from '@omadia/plugin-api';

import type { ChannelUserRef } from './incoming.js';
import type { ConversationType } from './conversationRoster.js';

export interface ConversationMessageEvent {
  /** The emitting channel plugin's catalog id. */
  channelId: string;
  /** The `channel_bindings.channel_type` selector (e.g. 'teams'). */
  channelType: string;
  conversationId: string;
  conversationType?: ConversationType;
  /** The bot identity that received the event (Teams: `28:<appId>`). The
   *  kernel stores the event only for a subscription of that identity. */
  receivedByChannelKey: string;
  /** Platform message id; for 'reaction' / 'card_answer' the message
   *  reacted to / the card answered. */
  messageId: string;
  /** 0 for the original; the adapter increments it per platform edit. */
  revision: number;
  kind: ConversationMessageKind;
  /** The platform-verified sender. Never derived from message text. */
  author: ChannelUserRef;
  tenantId?: string;
  /** Plain text, mentions resolved, markup stripped. Absent for 'deleted'. */
  text?: string;
  replyToMessageId?: string;
  quoted?: boolean;
  forwarded?: boolean;
  reaction?: { name: string; removed: boolean };
  /** `answererVerified: false` when the platform did not state who clicked
   *  (no verified user id on the activity). */
  /** For a question card (#2089) additionally `answers` (one typed value per
   *  answered question) and the `proposalId` / `proposalVersion` the card
   *  carried. The author is the platform's statement of who clicked, never
   *  anything from the card's data. */
  cardAnswer?: MessageCardAnswer;
  /** ISO 8601 timestamp of the platform event. */
  occurredAt: string;
  /** #2089 — the message addresses the receiving bot (a mention of it). An
   *  identity that only gets ADDRESSED messages of a conversation
   *  (`conversationDelivery` answers `addressed`) is handed the message only
   *  when this is `true`, or when it replies to one of the bot's messages or
   *  answers one of its cards. */
  addressedToBot?: boolean;
  /** #2089 — required for kind 'transcript_segment': the session and media
   *  source. `messageId` is the stable segment id, `text` the transcribed
   *  text; for a shared source `author` names the media source (kind
   *  `custom`, id `media:<source>`), never a person. */
  transcript?: MessageTranscriptSegment;
  /** The original platform event, opaque to the kernel and not stored. */
  rawEvent?: unknown;
}
