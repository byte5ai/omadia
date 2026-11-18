// Channel readiness and per-session capability snapshot (#2043, #2077).
//
// What an agent can perceive and do in a conversation is limited by the
// channel and its media, not by the agent. Channel plugins declare it through
// the channel-sdk; the kernel exposes it to engine plugins through the two
// read services below. A missing capability is information, never an error.

export const CHANNEL_READINESS_SERVICE_NAME = 'channelReadiness';
export const SESSION_CAPABILITIES_SERVICE_NAME = 'sessionCapabilities';

export interface ChannelReadinessIssue {
  /** e.g. 'app_not_installed', 'consent_missing', 'cannot_post', 'no_identity'. */
  code: string;
  /** Precise, operator-readable reason. */
  message: string;
}

/** Whether an agent's own identity can moderate a conversation: installed
 *  there, allowed to read every message, able to post. */
export interface ChannelReadinessReport {
  ready: boolean;
  installed: boolean;
  /** The agent may read messages that do not mention it (Teams: RSC
   *  `ChatMessage.Read.Chat` consented in this chat). */
  canReadAllMessages: boolean;
  canPost: boolean;
  /** Empty when `ready`. One entry per thing that is missing. */
  missing: readonly ChannelReadinessIssue[];
}

export interface ChannelReadinessService {
  check(request: {
    agentSlug: string;
    channelType: string;
    conversationId: string;
  }): Promise<ChannelReadinessReport>;
}

export type SessionInputCapability =
  | 'text'
  | 'message_edits'
  | 'reactions'
  | 'card_answers'
  | 'presence'
  | 'hand_raise'
  | 'transcribed_speech'
  | 'shared_documents';

export type SessionOutputCapability =
  | 'text'
  | 'mentions'
  | 'cards'
  | 'polls'
  | 'private_messages'
  | 'pinned_surface'
  | 'voice'
  | 'screen';

export interface SessionCapabilitySnapshot {
  channelType: string;
  conversationId: string;
  /** The live session (meeting) the snapshot is about; absent for the
   *  conversation's asynchronous baseline. */
  sessionRef?: string;
  modality: 'chat' | 'online' | 'hybrid';
  inputs: readonly SessionInputCapability[];
  outputs: readonly SessionOutputCapability[];
  /** ISO 8601. */
  capturedAt: string;
}

export interface SessionCapabilitiesService {
  /** The current snapshot. A channel without a meeting source reports the
   *  chat baseline (text in, text out) rather than nothing. */
  getSnapshot(request: {
    agentSlug: string;
    channelType: string;
    conversationId: string;
    sessionRef?: string;
  }): Promise<SessionCapabilitySnapshot>;
  /** Fires when a channel reports a changed snapshot mid-session. */
  onChange(
    agentSlug: string,
    handler: (snapshot: SessionCapabilitySnapshot) => void | Promise<void>,
  ): () => void;
}
