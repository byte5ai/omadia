// Group-conversation primitives (#330 B1): conversation type + participant
// roster, defined at the SDK contract level so ANY group-aware agent can use
// them — Teams implements first, Telegram/Discord follow. Strictly additive:
// a classic adapter that never touches any of this keeps working unchanged.

import type { ChannelUserRef, IncomingTurn } from './incoming.js';

export type ConversationType = 'direct' | 'group';

/** One member of a conversation, as the channel knows it. Field names align
 *  with the orchestrator's ChatParticipant deliberately WITHOUT importing it —
 *  the SDK must not depend on the orchestrator package. */
export interface ConversationParticipant {
  userRef: ChannelUserRef;
  /** True for bot/agent identities (including the agent's own). */
  isBot?: boolean;
  /** Channel-native stable id where it differs from userRef.id (e.g. AAD oid). */
  externalId?: string | null;
  /** e.g. the Entra userPrincipalName, when the channel can resolve it. */
  userPrincipalName?: string | null;
}

/**
 * A conversation's current membership. Same "absence is a type" discipline as
 * roleHolderSource.ts: an empty `participants` with `partial: false` is a real
 * answer ("nobody but you"), while `partial: true` means the source could not
 * read the full roster — nothing may be concluded from an id's absence then.
 */
export interface ConversationRoster {
  conversationType: ConversationType;
  participants: readonly ConversationParticipant[];
  /** The agent's own identity in this conversation, when the channel knows it. */
  self?: ConversationParticipant;
  partial: boolean;
}

/**
 * Optional per-channel roster capability. A channel plugin registers one via
 * `core.registerRosterProvider?.(channelId, provider)` (feature-detect — older
 * kernels do not define the method). `getRoster` returns undefined for a
 * conversation the channel cannot resolve; it must not throw for that case.
 */
export interface ConversationRosterProvider {
  /** The `channel_bindings.channel_type` this provider serves (e.g. 'teams'). */
  channelType: string;
  getRoster(conversationId: string): Promise<ConversationRoster | undefined>;
}

/**
 * Group-vs-direct in one place. `conversationType` is additive and optional on
 * IncomingTurn: absent means "unknown" (a classic adapter) and consumers treat
 * unknown as direct — no group semantics without a positive statement.
 */
export function isGroupConversation(turn: Pick<IncomingTurn, 'conversationType'>): boolean {
  return turn.conversationType === 'group';
}
