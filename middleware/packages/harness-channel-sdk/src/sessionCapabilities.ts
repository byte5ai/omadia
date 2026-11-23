// Channel-side declarations for readiness and session capabilities (#2043,
// #2077). Optional capabilities with the usual discipline: feature-detect the
// CoreApi method, the kernel drops the provider when the channel deactivates,
// and a provider RETURNS what is missing instead of throwing.

import type {
  ChannelConsentRepairOutcome,
  ChannelReadinessReport,
  SessionCapabilitySnapshot,
  SessionEventKind,
} from '@omadia/plugin-api';

import type { ChannelUserRef } from './incoming.js';

export interface ChannelReadinessProvider {
  /** The `channel_bindings.channel_type` this provider serves. */
  channelType: string;
  /** Can the identity `asChannelKey` moderate this conversation: installed
   *  there, allowed to read messages without a mention, able to post? */
  check(conversationId: string, opts: { asChannelKey: string }): Promise<ChannelReadinessReport>;
  /** Optional: repair missing consent for that identity in the conversation
   *  (Teams: upgrade the app installation). RETURNS a failure, never throws. */
  repairConsent?(
    conversationId: string,
    opts: { asChannelKey: string },
  ): Promise<ChannelConsentRepairOutcome>;
}

/**
 * A meeting lifecycle event (#2043). The adapter emits every one it receives,
 * subscribed or not, once per receiving bot; the kernel delivers it only to
 * an engine that holds a message subscription for the conversation, removes
 * the duplicates and stores nothing.
 */
export interface SessionEvent {
  /** The emitting channel plugin's catalog id. */
  channelId: string;
  channelType: string;
  conversationId: string;
  /** The live session (meeting) the event is about. */
  sessionRef: string;
  kind: SessionEventKind;
  /** Present for 'participant_joined' / 'participant_left'. */
  participants?: readonly ChannelUserRef[];
  /** ISO 8601 timestamp of the platform event. */
  occurredAt: string;
}

/**
 * The `MeetingSource` abstraction of #330 / #584: a channel or media plugin
 * declares what a session offers. Audio is one input among several; a source
 * that only knows the meeting chat is a complete source.
 */
export interface MeetingSourceProvider {
  channelType: string;
  /** `undefined` when the provider knows nothing about the conversation; the
   *  kernel then reports the chat baseline. */
  snapshot(
    conversationId: string,
    opts: { asChannelKey?: string; sessionRef?: string },
  ): Promise<SessionCapabilitySnapshot | undefined>;
}
