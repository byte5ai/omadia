// Conversation-membership lifecycle events (#330 B2 seam, shipped with B1):
// "the agent was invited / members changed", emitted by a channel adapter via
// `core.emitConversationEvent?.(event)`. The Facilitator uses `bot_added` (and
// WHO added it) as its explicit, announced entry into a group — nobody is
// moderated covertly.

import type { ChannelUserRef } from './incoming.js';
import type { ConversationType } from './conversationRoster.js';

interface ConversationEventBase {
  /** The emitting channel plugin's catalog id (e.g. 'de.byte5.channel.teams'). */
  channelId: string;
  /** The `channel_bindings.channel_type` selector, when the adapter knows it. */
  channelType?: string;
  conversationId: string;
  conversationType?: ConversationType;
  /** The members this event is about (added or removed, per kind). */
  members: readonly ChannelUserRef[];
  /** ISO 8601 timestamp of the platform event. */
  occurredAt: string;
  /** The original platform event, opaque to the kernel. */
  rawEvent?: unknown;
}

/** The agent itself was added to the conversation. `addedBy` is best-effort:
 *  Teams carries it in `conversationUpdate`; channels that cannot resolve the
 *  inviter simply omit it. */
export interface BotAddedEvent extends ConversationEventBase {
  kind: 'bot_added';
  addedBy?: ChannelUserRef;
}

export interface MembersAddedEvent extends ConversationEventBase {
  kind: 'members_added';
}

export interface MembersRemovedEvent extends ConversationEventBase {
  kind: 'members_removed';
}

/** #330 field report round 3 — the agent observed it is ALREADY a member of a
 *  group conversation (an inbound group message is transport-verified proof of
 *  membership; a bot added long ago never gets another `bot_added`). This is
 *  an ELIGIBILITY signal only: consumers may record that a facilitation COULD
 *  bind here, but must not eagerly bind or announce anything — the deliberate
 *  entry stays `bot_added`. `addedBy` carries the message's verified sender
 *  (the person engaging the agent), best-effort like on `bot_added`. */
export interface BotPresentEvent extends ConversationEventBase {
  kind: 'bot_present';
  addedBy?: ChannelUserRef;
}

export type ConversationMembershipEvent = BotAddedEvent | MembersAddedEvent | MembersRemovedEvent | BotPresentEvent;
