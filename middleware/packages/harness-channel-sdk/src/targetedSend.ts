// Targeted delivery (#330 B3): post to ONE participant (a DM) distinct from
// posting to the group, addressed by Principal ('user:<id>' | 'role:<key>').
// The kernel resolves the principal — a role fans out to ALL current holders
// at send time (notification semantics: one delivery per holder, no quorum,
// late-bound membership) — and hands the channel plugin exactly ONE resolved
// user per delivery. Role→holder resolution stays a kernel invariant (the
// holder-source union is security-critical, see roleHolderSource.ts); channel
// plugins never resolve principals themselves.

import type { ChannelUserRef } from './incoming.js';
import type { OutgoingAttachment } from './outgoing.js';
import type { Principal } from './principal.js';

/** Deliberately narrower than SemanticAnswer: a targeted message is a report /
 *  status ping, not a full conversational reply. */
export interface TargetedMessage {
  text: string;
  attachments?: OutgoingAttachment[];
  /** People to @mention (#2043). Each `text` occurs in `text`; the provider
   *  turns that occurrence into a platform mention. A provider without
   *  mentions leaves the text as it is. */
  mentions?: readonly TargetedMention[];
  /** Post the message as a poll (#2043). A provider without polls returns
   *  `unreachable` (`channel_error`) instead of posting plain text; an
   *  invalid poll is refused the same way and nothing is posted. */
  poll?: TargetedPoll;
}

export interface TargetedPoll {
  /** 1..128 characters; round-tripped as `cardAnswer.cardId`. */
  pollId: string;
  question: string;
  /** 2..6 options, ids unique. */
  options: readonly { id: string; label: string }[];
  hint?: string;
}

export interface TargetedMention {
  user: ChannelUserRef;
  /** The display text standing in the message (e.g. '@Anna Köhler'). */
  text: string;
}

/** Options for a user-addressed send (#2043). */
export interface TargetedSendOptions {
  /** Identity the DM must come from (Teams: `28:<appId>`). Same contract as
   *  `ConversationSendOptions.asChannelKey`: a provider that implements it
   *  returns `unreachable` rather than substituting another identity. */
  asChannelKey?: string;
}

/** Per-delivery outcome. Providers RETURN unreachability (like holdersFor in
 *  roleHolderSource.ts) — they never throw for it, so one unreachable holder
 *  cannot abort the remaining fan-out deliveries. */
export type TargetedDeliveryOutcome =
  /** `messageId` is the platform id of the sent message when known. A poll
   *  may go out as two messages (text, then card): `cardMessageId` is the
   *  card, and the `messageId` of every `card_answer` event for it. */
  | { outcome: 'delivered'; messageId?: string; cardMessageId?: string }
  | {
      outcome: 'unreachable';
      /** 'app_not_installed': first contact is impossible because the user
       *  never installed this identity's app. 'blocked': the user blocked it. */
      code:
        | 'no_binding'
        | 'user_not_found'
        | 'channel_error'
        | 'not_permitted'
        | 'app_not_installed'
        | 'blocked';
      message: string;
    };

/**
 * Optional per-channel delivery capability. A channel plugin registers one via
 * `core.registerTargetedSendProvider?.(channelId, provider)` (feature-detect).
 * `target.principalId` is the canonical user id; `conversationRef` is the
 * kernel-cached per-user conversation reference when one exists (Teams:
 * channel_bindings row) — a provider that can materialize a 1:1 conversation
 * itself (proactive messaging) may ignore it.
 */
/**
 * What a send provider DECLARES it implements (#2043). The kernel cannot see
 * whether a provider honoured an option: an older provider ignores an
 * argument it does not know and still answers `delivered` — through its
 * default bot. So the kernel sends as a named identity, with mentions or as a
 * poll only to a provider that declared the capability, and refuses
 * otherwise (`no_identity` for an identity it cannot guarantee,
 * `channel_error` for a poll). Absent = the provider implements none.
 */
export interface SendProviderCapabilities {
  /** Honours `opts.asChannelKey`: posts as exactly that identity or returns
   *  `unreachable`, never as another one. */
  asChannelKey?: boolean;
  /** Turns `message.mentions` into platform mentions. */
  mentions?: boolean;
  /** Posts `message.poll` as a poll and refuses an invalid one. */
  poll?: boolean;
}

export interface TargetedSendProvider {
  /** The `channel_bindings.channel_type` this provider serves (e.g. 'teams'). */
  channelType: string;
  /** Declared capabilities; see {@link SendProviderCapabilities}. */
  supports?: SendProviderCapabilities;
  sendToUser(
    target: { principalId: string; conversationRef?: unknown; userRef?: ChannelUserRef },
    message: TargetedMessage,
    opts?: TargetedSendOptions,
  ): Promise<TargetedDeliveryOutcome>;
}

/** Why a send produced fewer deliveries than the caller may expect. Never a
 *  silent drop: every non-delivery is named. */
export interface TargetedSendDiagnostic {
  code:
    | 'invalid_principal'
    | 'no_targeted_send_provider'
    | 'role_resolution_unavailable'
    | 'role_has_no_holders'
    | 'role_resolution_partial'
    | 'holder_unreachable';
  message: string;
  /** The holder a per-holder diagnostic is about. */
  principalId?: string;
}

/**
 * The full, honest result of one targeted send. `resolution.partial` mirrors
 * AggregateHolderLookup: the holder list was a lower bound, so "delivered to
 * everyone listed" must NOT be read as "delivered to every holder".
 */
export interface TargetedSendReport {
  /** Absent when the input was not a parseable principal (see the
   *  'invalid_principal' diagnostic) — never a fabricated empty user. */
  principal?: Principal;
  resolution:
    | { kind: 'single-user' }
    | { kind: 'role'; holders: readonly string[]; partial: boolean };
  deliveries: readonly { principalId: string; outcome: TargetedDeliveryOutcome }[];
  diagnostics: readonly TargetedSendDiagnostic[];
}
