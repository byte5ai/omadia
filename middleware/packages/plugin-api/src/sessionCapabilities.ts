// Channel readiness and per-session capability snapshot (#2043, #2077).
//
// What an agent can perceive and do in a conversation is limited by the
// channel and its media, not by the agent. Channel plugins declare it through
// the channel-sdk; the kernel exposes it to engine plugins through the two
// read services below. A missing capability is information, never an error.

export const CHANNEL_READINESS_SERVICE_NAME = 'channelReadiness';
export const SESSION_CAPABILITIES_SERVICE_NAME = 'sessionCapabilities';

/**
 * Codes a readiness report can carry. Open-ended on purpose (`code` is a
 * string): a consumer that does not know a code still sees `ready: false` and
 * must not start. The ones in use:
 *
 * - `no_identity`        the agent has no identity of its own on the channel
 * - `app_not_installed`  its app is not installed in the conversation
 * - `consent_missing`    installed, but it may not read every message
 * - `cannot_post`        it cannot post there (no reference, last post failed)
 * - `graph_forbidden`    the instance lacks the permission to check or repair
 * - `graph_error`        the platform API answered with an error
 * - `graph_unavailable`  the instance has no credentials for the platform API
 * - `team_unknown`       a team channel whose team the channel has not seen yet
 * - `unsupported_conversation`  this kind of conversation cannot be moderated
 * - `package_outdated`   (repair) the published app lacks the permissions
 */
export type ChannelReadinessCode =
  | 'no_identity'
  | 'app_not_installed'
  | 'consent_missing'
  | 'cannot_post'
  | 'graph_forbidden'
  | 'graph_error'
  | 'graph_unavailable'
  | 'team_unknown'
  | 'unsupported_conversation'
  | 'package_outdated';

export interface ChannelReadinessIssue {
  /** One of {@link ChannelReadinessCode}, or a code a newer channel added. */
  code: ChannelReadinessCode | (string & {});
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
  /** `false` when the channel declares that it delivers every message but
   *  could not check this conversation (the report then states the absence
   *  of a known obstacle, not a verified state). Absent or `true` = checked.
   *  A channel type that registered no readiness provider at all is NOT
   *  ready: it reports `unsupported_conversation`. */
  verified?: boolean;
}

export interface ChannelReadinessRequest {
  agentSlug: string;
  channelType: string;
  conversationId: string;
}

/** What a consent repair did (Teams: upgrade the app installation in the chat
 *  to the permissions the published app declares). */
export type ChannelConsentRepairOutcome =
  | { outcome: 'upgraded'; installationId?: string; permissions?: readonly string[] }
  | { outcome: 'not_needed' }
  | {
      outcome: 'failed';
      /** A {@link ChannelReadinessCode}, or `unsupported` when the channel
       *  offers no repair. */
      code: ChannelReadinessCode | 'unsupported' | (string & {});
      message: string;
    };

export interface ChannelReadinessService {
  check(request: ChannelReadinessRequest): Promise<ChannelReadinessReport>;
  /** Try to repair missing consent for the agent's own identity in this
   *  conversation. Optional — feature-detect on older kernels. Answers
   *  `failed / unsupported` when the channel offers no repair. */
  repairConsent?(request: ChannelReadinessRequest): Promise<ChannelConsentRepairOutcome>;
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
  /** Fires when a channel reports a changed snapshot mid-session, for
   *  conversations the agent holds a message subscription for. Read
   *  `getSnapshot` on demand as well; a channel may never push. */
  onChange(
    agentSlug: string,
    handler: (snapshot: SessionCapabilitySnapshot) => void | Promise<void>,
  ): () => void;
  /** Meeting lifecycle (#2043): start, end, participants joining and leaving.
   *  Delivered only for conversations the agent holds a message subscription
   *  for; the kernel stores nothing. Optional — feature-detect. */
  onSessionEvent?(
    agentSlug: string,
    handler: (event: SessionEventRecord) => void | Promise<void>,
  ): () => void;
}

export type SessionEventKind =
  | 'session_started'
  | 'session_ended'
  | 'participant_joined'
  | 'participant_left';

export interface SessionEventParticipant {
  /** Channel-user namespace, as in `ConversationMessageRecord.author`. */
  kind: string;
  id: string;
  displayName?: string;
  /** Canonical principal ('user:<id>'), filled like a message author's. */
  principalId?: string;
}

/** One session event as an engine receives it. */
export interface SessionEventRecord {
  channelType: string;
  conversationId: string;
  /** The live session (meeting) the event is about. */
  sessionRef: string;
  kind: SessionEventKind;
  /** Present for the two participant kinds. */
  participants?: readonly SessionEventParticipant[];
  /** ISO 8601, platform time. */
  occurredAt: string;
}
