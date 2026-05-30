import type { TargetRef } from '@omadia/plugin-api';

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
  /**
   * Per-deployment tenant id. Additive (Omadia UI). Classic channels leave it
   * unset; the canvas channel populates it, and the core defaults it to
   * `"default"` at the call site, not here.
   */
  tenantId?: string;
  /**
   * Canvas target for this turn (Omadia UI). Absent (or a
   * `{ kind: 'canvas', canvasSessionId }` target) means a canvas-level prompt;
   * any other `kind` scopes the turn to that target's subtree (container-scoped
   * prompt / beam granularity). Classic channels never set it.
   */
  target?: TargetRef;
  /**
   * Per-container client view-state snapshot (sort / filter / group / selection
   * / …) carried for referential continuity (Omadia UI). Tier 2 reads it,
   * never writes it. Classic channels never set it.
   */
  viewState?: CanvasViewState;
  /**
   * `true` when the `viewState` blob (or a container's `selection`) was
   * truncated to stay within the payload budget (Omadia UI). Tier 2's skill
   * requires explicit confirmation before mutating across a truncated
   * selection. Classic channels never set it.
   */
  viewStateTruncated?: boolean;
}

/**
 * A container's current selection in `viewState`. Normally the full set of
 * selected {@link TargetRef}s; when the selection exceeds the per-container cap
 * it is shipped as a clearly-marked truncated sample so Tier 2 can decide
 * whether to fetch the full set via a Tier-3 lookup.
 */
export type CanvasSelection =
  | TargetRef[]
  | {
      kind: 'truncated';
      includedCount: number;
      totalCount: number;
      /** first `includedCount` ids by viewState ordering */
      sample: TargetRef[];
    };

/**
 * Per-container view-state the Omadia UI client ships alongside a turn so the
 * agent can resolve references ("of them", "this row") against stable ids. Keyed
 * by `containerId`. Selection lives here (each entry is a {@link TargetRef}), not
 * in the agent-owned tree.
 */
export type CanvasViewState = Record<
  string,
  {
    sort?: { columnKey: string; direction: 'asc' | 'desc' };
    filter?: { predicate: string };
    group?: { columnKey: string };
    hiddenColumns?: string[];
    page?: { index: number; size: number };
    selection?: CanvasSelection;
    /** tree nodes / accordion-open rows, by stable item key */
    expanded?: string[];
    /** optional; only when referentially meaningful */
    scrollTop?: number;
  }
>;

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
