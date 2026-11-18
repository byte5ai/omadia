// What the kernel accepts from a channel adapter as an inbound message event
// (#2043): validation at the boundary and the conversion into the stored
// form. Kept apart from the hub so the rules about "what counts as a valid
// event" are readable on their own.

import type { ConversationMessageEvent } from '@omadia/channel-sdk';
import type { ConversationMessageKind } from '@omadia/plugin-api';

import type { NewMessageEvent } from './store.js';

const KINDS: readonly ConversationMessageKind[] = ['created', 'edited', 'deleted', 'reaction', 'card_answer'];
export const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 100_000;
/** An adapter's edit counter is a hint; one outside this range is ignored
 *  (the column is a 32-bit integer, and no message is edited a million times). */
export const MAX_ADAPTER_REVISION = 1_000_000;

export function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Why the event is not acceptable, or `undefined` when it is. */
export function validateMessageEvent(event: ConversationMessageEvent): string | undefined {
  if (event === null || typeof event !== 'object') return 'not an object';
  if (!isBoundedText(event.channelType, 64)) return 'channelType';
  if (!isBoundedText(event.conversationId, MAX_ID_LENGTH)) return 'conversationId';
  if (!isBoundedText(event.receivedByChannelKey, MAX_ID_LENGTH)) return 'receivedByChannelKey';
  if (!isBoundedText(event.messageId, MAX_ID_LENGTH)) return 'messageId';
  if (!KINDS.includes(event.kind)) return 'kind';
  if (!event.author || !isBoundedText(event.author.id, MAX_ID_LENGTH) || !isBoundedText(event.author.kind, 64)) {
    return 'author';
  }
  if (typeof event.occurredAt !== 'string' || Number.isNaN(Date.parse(event.occurredAt))) return 'occurredAt';
  if (event.text !== undefined && typeof event.text !== 'string') return 'text';
  if (event.kind === 'reaction' && !isBoundedText(event.reaction?.name, 128)) return 'reaction';
  if (event.kind === 'card_answer' && !isBoundedText(event.cardAnswer?.cardId, MAX_ID_LENGTH)) return 'cardAnswer';
  return undefined;
}

/**
 * The answer as stored. `answererVerified` is taken from the explicit field,
 * or from inside `value` (where an adapter that predates the field put it),
 * so the engine reads ONE place.
 */
function readCardAnswer(answer: NonNullable<ConversationMessageEvent['cardAnswer']>): NonNullable<
  NewMessageEvent['cardAnswer']
> {
  const nested = (answer.value as { answererVerified?: unknown } | null)?.answererVerified;
  const verified =
    typeof answer.answererVerified === 'boolean'
      ? answer.answererVerified
      : typeof nested === 'boolean'
        ? nested
        : undefined;
  return {
    cardId: answer.cardId,
    value: answer.value,
    ...(verified !== undefined ? { answererVerified: verified } : {}),
  };
}

/** The adapter's event as the store takes it. `principalId` is the kernel's
 *  own resolution of the author. */
export function toStoredEvent(event: ConversationMessageEvent, principalId: string | undefined): NewMessageEvent {
  const hint = event.revision;
  return {
    messageId: event.messageId,
    ...(Number.isInteger(hint) && hint >= 0 && hint <= MAX_ADAPTER_REVISION ? { adapterRevision: hint } : {}),
    kind: event.kind,
    author: {
      kind: event.author.kind,
      id: event.author.id,
      ...(typeof event.author.displayName === 'string' ? { displayName: event.author.displayName.slice(0, 256) } : {}),
      ...(principalId !== undefined ? { principalId } : {}),
    },
    ...(typeof event.tenantId === 'string' ? { tenantId: event.tenantId } : {}),
    ...(typeof event.text === 'string' ? { text: event.text.slice(0, MAX_TEXT_LENGTH) } : {}),
    ...(typeof event.replyToMessageId === 'string' ? { replyToMessageId: event.replyToMessageId } : {}),
    ...(event.quoted === true ? { quoted: true } : {}),
    ...(event.forwarded === true ? { forwarded: true } : {}),
    ...(event.kind === 'reaction' && event.reaction
      ? { reaction: { name: event.reaction.name, removed: event.reaction.removed === true } }
      : {}),
    ...(event.kind === 'card_answer' && event.cardAnswer ? { cardAnswer: readCardAnswer(event.cardAnswer) } : {}),
    occurredAt: new Date(event.occurredAt).toISOString(),
  };
}
