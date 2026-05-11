import type { RequestHandler, Router } from 'express';

import type { IncomingTurn, ChannelUserRef, PlatformIdentity } from './incoming.js';
import type { ChatStreamEvent } from './streamEvent.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
}
