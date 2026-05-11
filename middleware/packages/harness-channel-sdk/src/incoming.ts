/**
 * Inbound message shape. Populated by the channel adapter from the native
 * event (Bot-Framework Activity / Slack event / Telegram update / …) and
 * passed into the core via `CoreApi.handleTurnStream`.
 */
export interface IncomingTurn {
  /** e.g. `"de.byte5.channel.teams"` */
  channelId: string;
  /** channel-specific thread/chat id */
  conversationId: string;
  /** channel-native user ref */
  userRef: ChannelUserRef;
  /** user's message as plain text (mentions resolved, markup stripped) */
  text: string;
  attachments?: IncomingAttachment[];
  /** Channel-specific metadata (locale, auth hints, etc.) — opaque to core. */
  metadata?: Record<string, unknown>;
  /** The original platform event, for adapters that need it on the way back. */
  rawEvent?: unknown;
}

export interface ChannelUserRef {
  /** Namespace identifying the channel-user space. */
  kind: ChannelUserKind;
  /** Channel-native user id (opaque to core). */
  id: string;
  displayName?: string;
  email?: string;
}

/**
 * Closed set of known channel-user namespaces. New channels must extend this
 * union (typed, so a typo at the channel plugin fails compilation).
 */
export type ChannelUserKind =
  | 'teams-aad' // Microsoft Teams / Azure AD
  | 'slack-user'
  | 'discord-user'
  | 'whatsapp-phone'
  | 'telegram-chat'
  | 'custom';

export interface IncomingAttachment {
  kind: 'image' | 'file' | 'audio' | 'video';
  url: string;
  mediaType: string;
  name?: string;
  sizeBytes?: number;
  /**
   * Optional pre-fetched bytes, base64-encoded. Channel adapters that
   * own a token-protected file URL (Telegram's bot-API getFile path,
   * for example) populate this so the kernel orchestrator never has to
   * see the channel-specific token. When present, the orchestrator
   * uses this directly for vision-API calls; when absent, the
   * orchestrator fetches `url` instead.
   *
   * Stability: additive in S+7.7. Channels that don't pre-fetch (e.g.
   * Teams via Graph) leave this undefined.
   */
  bytesBase64?: string;
}

/**
 * Platform-side identity resolved from a channel-user ref. v1 wraps the
 * ChannelUserRef without merging across channels. Once the PlatformIdentity
 * registry (Slice 2.5) lands, `platformId` can bridge multiple channels.
 */
export interface PlatformIdentity {
  /** v1: `${channel-kind}:${id}` */
  platformId: string;
  channelUserRef: ChannelUserRef;
  displayName?: string;
  email?: string;
}
