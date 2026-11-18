// Channel-side declarations for readiness and session capabilities (#2043,
// #2077). Optional capabilities with the usual discipline: feature-detect the
// CoreApi method, the kernel drops the provider when the channel deactivates,
// and a provider RETURNS what is missing instead of throwing.

import type { ChannelReadinessReport, SessionCapabilitySnapshot } from '@omadia/plugin-api';

export interface ChannelReadinessProvider {
  /** The `channel_bindings.channel_type` this provider serves. */
  channelType: string;
  /** Can the identity `asChannelKey` moderate this conversation: installed
   *  there, allowed to read messages without a mention, able to post? */
  check(conversationId: string, opts: { asChannelKey: string }): Promise<ChannelReadinessReport>;
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
