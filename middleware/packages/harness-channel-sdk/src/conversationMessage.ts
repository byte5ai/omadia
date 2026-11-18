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

import type { ConversationMessageKind } from '@omadia/plugin-api';

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
  cardAnswer?: { cardId: string; value: unknown; answererVerified?: boolean };
  /** ISO 8601 timestamp of the platform event. */
  occurredAt: string;
  /** The original platform event, opaque to the kernel and not stored. */
  rawEvent?: unknown;
}
