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
}

/** Per-delivery outcome. Providers RETURN unreachability (like holdersFor in
 *  roleHolderSource.ts) — they never throw for it, so one unreachable holder
 *  cannot abort the remaining fan-out deliveries. */
export type TargetedDeliveryOutcome =
  | { outcome: 'delivered' }
  | {
      outcome: 'unreachable';
      code: 'no_binding' | 'user_not_found' | 'channel_error' | 'not_permitted';
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
export interface TargetedSendProvider {
  /** The `channel_bindings.channel_type` this provider serves (e.g. 'teams'). */
  channelType: string;
  sendToUser(
    target: { principalId: string; conversationRef?: unknown; userRef?: ChannelUserRef },
    message: TargetedMessage,
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
