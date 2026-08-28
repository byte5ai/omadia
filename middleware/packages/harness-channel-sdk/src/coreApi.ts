import type { RequestHandler, Router } from 'express';

import type { IncomingTurn, ChannelUserRef, PlatformIdentity } from './incoming.js';
import type { ChatStreamEvent } from './streamEvent.js';
import type { ConversationRosterProvider } from './conversationRoster.js';
import type { ConversationMembershipEvent } from './membershipEvent.js';
import type { TargetedSendProvider } from './targetedSend.js';
import type { ConversationSendProvider } from './conversationSend.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Authenticated session identity handed to a {@link ChannelSocketHandler}.
 * The core verifies the session cookie at upgrade time — BEFORE the WebSocket
 * handshake completes — so a handler only ever sees an authenticated peer.
 * Mirrors the kernel's session claims without coupling the SDK to its JWT
 * types.
 */
export interface ChannelSessionClaims {
  /** Stable per-user id within the issuing provider (the session `sub`). */
  subject: string;
  email: string;
  displayName: string;
  /** Provider the session was minted by ('local' | 'entra' | plugin id). */
  provider: string;
  /** Omadia-Identity cluster root in the knowledge graph, when resolved. */
  omadiaUserId?: string;
}

/**
 * A transport-agnostic WebSocket the core hands to a channel's
 * {@link ChannelSocketHandler}. Deliberately narrow — text frames only (canvas
 * protocol frames are JSON strings); no binary or backpressure API in v1. The
 * kernel owns the concrete `ws` implementation behind it.
 */
export interface ChannelSocket {
  /** Send one text frame. */
  send(data: string): void;
  /** Subscribe to inbound text frames. */
  onMessage(cb: (data: string) => void): void;
  /** Subscribe to socket close. */
  onClose(cb: () => void): void;
  /** Close the socket (optional close code + reason). */
  close(code?: number, reason?: string): void;
  /** The upgrade request that opened this socket (read-only). */
  readonly request: {
    url: string;
    headers: Record<string, string | string[] | undefined>;
  };
}

/**
 * Handler a channel registers for a WebSocket path. Invoked once per accepted
 * connection, AFTER the core has authenticated the upgrade — `session` is the
 * verified identity.
 */
export type ChannelSocketHandler = (
  socket: ChannelSocket,
  session: ChannelSessionClaims,
) => void;

/**
 * What channels call on the core. The core hands an instance of this to each
 * `ChannelPlugin.activate(ctx, core)`. Channels use it to drive orchestrator
 * turns, register routes (scoped to the channel so they can be deactivated
 * together), and resolve channel-native user refs to platform identities.
 */
export interface CoreApi {
  /**
   * Drive an orchestrator turn with the user's message. Returns a stream of
   * events the channel adapter translates to native format.
   *
   * Backed by the currently-active orchestrator (the `chatAgent` service). For
   * a folded {@link SemanticAnswer} (one `await`, no event loop) or richer
   * control, resolve the agent directly via `getChatAgent(ctx)` instead.
   */
  handleTurnStream(turn: IncomingTurn): AsyncIterable<ChatStreamEvent>;

  /**
   * Register an HTTP route owned by a specific channel. The core will
   * un-mount it (return 503) when the channel is deactivated, without
   * restarting the Express app.
   */
  registerRoute(
    channelId: string,
    method: HttpMethod,
    path: string,
    handler: RequestHandler,
  ): void;

  /**
   * Register a complete Express Router under a prefix. Useful for channels
   * that ship multiple endpoints (webhook, callback, file-proxy, …). Same
   * active-flag semantics: deactivating the channel makes all routes under
   * this prefix return 503 until re-activated.
   */
  registerRouter(channelId: string, prefix: string, router: Router): void;

  /**
   * Resolve a channel-native user reference to a platform identity. v1 is
   * a passthrough (one PlatformIdentity per ChannelUserRef; no cross-channel
   * merging yet). Slice 2.5 introduces the mapping table.
   */
  resolveIdentity(ref: ChannelUserRef): Promise<PlatformIdentity>;

  /** Channel-scoped logger. Always prefixed with the channel id in output. */
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void;

  /**
   * Register a WebSocket endpoint owned by a channel. The core authenticates
   * the upgrade (session cookie) and rejects unauthenticated peers BEFORE the
   * handshake completes — the handler only ever receives an authenticated
   * socket plus its verified {@link ChannelSessionClaims}. Same active-flag
   * lifecycle as {@link registerRoute}: deactivating the channel rejects new
   * upgrades and closes its live sockets.
   *
   * Optional: present only when the kernel wired a WebSocket registry into
   * `createCoreApi`. Channels MUST feature-detect
   * (`typeof core.registerWebSocket === 'function'`) before using it.
   */
  registerWebSocket?(
    channelId: string,
    path: string,
    handler: ChannelSocketHandler,
  ): void;

  /**
   * Register the channel's participant-roster capability (#330 B1). Optional:
   * present only when the kernel wired a roster registry into `createCoreApi`.
   * Channels MUST feature-detect
   * (`typeof core.registerRosterProvider === 'function'`) before using it.
   * Same active-flag lifecycle as routes: the kernel drops the provider when
   * the channel deactivates.
   */
  registerRosterProvider?(channelId: string, provider: ConversationRosterProvider): void;

  /**
   * Register the channel's targeted-send (DM one participant) capability
   * (#330 B3). Optional — same feature-detect + deactivate lifecycle as
   * {@link registerRosterProvider}. Principal→user resolution (incl. role
   * fan-out) happens in the kernel; the provider only ever delivers to one
   * already-resolved user.
   */
  registerTargetedSendProvider?(channelId: string, provider: TargetedSendProvider): void;

  /**
   * Emit a conversation-membership event (#330 B2): the agent was invited,
   * members joined/left. Optional — feature-detect. Fire-and-forget from the
   * adapter's perspective; the kernel fans it out to subscribers (e.g. a
   * Facilitator waiting for its `bot_added` handshake trigger).
   */
  emitConversationEvent?(event: ConversationMembershipEvent): void;

  /**
   * Register the channel's conversation-addressed proactive-send capability
   * (#330 C3b — group nudges). Optional — same feature-detect + deactivate
   * lifecycle as {@link registerTargetedSendProvider}.
   */
  registerConversationSendProvider?(channelId: string, provider: ConversationSendProvider): void;
}
