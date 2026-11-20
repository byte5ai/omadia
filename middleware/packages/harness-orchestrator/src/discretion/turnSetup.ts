/**
 * Spec 2042 §5.11 — what a turn starts with: its own conversation context
 * (key and readers) and the label a message from a person carries ("the
 * conversation context and its members").
 */

import { formatSessionScope, type TurnOrigin } from '@omadia/channel-sdk';

import { readersOf, UNKNOWN_READERS, type DiscretionLabel, type Readers } from './labels.js';
import type { TurnAudience } from '../turnAudience.js';

/**
 * The context key of a turn's conversation, or undefined for a turn without
 * an origin (web chat, API, internal runs): those carry no conversation label.
 * Prefers the id the channel stated; falls back to the scope it gave.
 */
export function conversationContextKey(origin: TurnOrigin | undefined): string | undefined {
  if (!origin) return undefined;
  const native = origin.channelConversationId ?? formatSessionScope(origin.scope);
  return `${origin.channelType}:${native}`;
}

export function readersFromAudience(audience: TurnAudience): Readers {
  return audience.kind === 'known' ? readersOf(audience.members) : UNKNOWN_READERS;
}

/** The label of a person's message in this conversation. */
export function conversationLabel(key: string, readers: Readers): DiscretionLabel {
  return { kind: 'context', key, readers };
}

/** Memoize an async resolver: the room is resolved at most once per turn. */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= fn();
    return pending;
  };
}
