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
  /** True unless the roster is complete. Kept for readers that predate
   *  {@link status}; a provider that sets `status` keeps the two consistent. */
  partial: boolean;
  /**
   * How much the channel could read (#2091, additive):
   *  - `complete`: every member is listed;
   *  - `partial`: some members are listed, absence of an id proves nothing;
   *  - `unknown`: the channel could not read the membership at all.
   * Absent = a provider that predates the field: read {@link partial}.
   */
  status?: ConversationRosterStatus;
  /** When the platform answered, ISO 8601 in UTC. A cached answer keeps the
   *  time of the original read. */
  readAt?: string;
  /** Why the roster is `partial` or `unknown`, for an operator to read. */
  statusDetail?: string;
}

export type ConversationRosterStatus = 'complete' | 'partial' | 'unknown';

/** Options of a roster request (additive; every field optional). */
export interface ConversationRosterRequest {
  /**
   * WHICH of the channel's identities asks, the same string as
   * `asChannelKey` on sends (Teams: `28:<appId>`). Absent = the adapter's
   * default identity.
   */
  readonly asChannelKey?: string;
  /** `true` (#2091): bypass the provider's cache and ask the platform now. */
  readonly fresh?: boolean;
}

/** The status of a roster for a reader that knows the field: the provider's
 *  own statement, else derived from `partial`. */
export function rosterStatusOf(roster: Pick<ConversationRoster, 'status' | 'partial'>): ConversationRosterStatus {
  return roster.status ?? (roster.partial ? 'partial' : 'complete');
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
  /**
   * `opts.asChannelKey` (#2043, additive): WHICH of the channel's identities
   * asks, the same string as `asChannelKey` on sends (Teams: `28:<appId>`).
   * A roster is what that bot can see, so a channel with several bots must
   * read it through that bot's own conversation reference and credentials,
   * and answer `undefined` when that bot is not in the conversation, never
   * another bot's view. Absent = the adapter's default identity, as before.
   *
   * `opts.fresh` (#2091, additive): `true` bypasses the provider's cache.
   *
   * `undefined` keeps meaning "this channel cannot resolve the conversation";
   * the kernel treats it as an unknown roster.
   */
  getRoster(
    conversationId: string,
    opts?: ConversationRosterRequest,
  ): Promise<ConversationRoster | undefined>;
}

/**
 * Group-vs-direct in one place. `conversationType` is additive and optional on
 * IncomingTurn: absent means "unknown" (a classic adapter) and consumers treat
 * unknown as direct — no group semantics without a positive statement.
 */
export function isGroupConversation(turn: Pick<IncomingTurn, 'conversationType'>): boolean {
  return turn.conversationType === 'group';
}
