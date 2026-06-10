import type { RequestHandler, Router } from 'express';

import type {
  ChatStreamEvent,
  ChannelSocketHandler,
  ChannelUserRef,
  CoreApi,
  HttpMethod,
  IncomingTurn,
  LogLevel,
  PlatformIdentity,
} from '@omadia/channel-sdk';
import type { ExpressRouteRegistry } from './routeRegistry.js';
import type { WebSocketRegistry } from './webSocketRegistry.js';

/**
 * Orchestrator adapter the CoreApi delegates to. Intentionally narrow — we
 * don't leak the full Orchestrator class into channels. Slice 2.3 can widen
 * this when Teams actually needs tool-trace or verifier data.
 */
export interface TurnDispatcher {
  streamTurn(input: {
    scope: string;
    /**
     * Originating channel id (= the channel plugin's catalog id). The
     * dispatcher uses it to resolve the channel's configured `dispatch_service`
     * (Omadia UI); absent-from-manifest falls back to the shared 'chatAgent'.
     */
    channelId: string;
    /**
     * US7 per-binding routing — the `channel_bindings.channel_type` selector
     * for this turn. Absent → the dispatcher derives it from `channelId`.
     */
    channelType?: string;
    /**
     * US7 per-binding routing — the `channel_bindings.channel_key` for this
     * turn (defaulted to the conversation id by the core). Paired with
     * `channelType` to look up the bound Agent's scoped orchestrator.
     */
    channelKey?: string;
    userRef: ChannelUserRef;
    text: string;
    metadata?: Record<string, unknown>;
    /**
     * Omadia UI: the TargetRef of the element a structured UI action
     * originated from (protocol 1.0 §5.1). Untyped at this layer; the
     * canvas-aware orchestrator narrows it. Classic channels never set it.
     */
    target?: unknown;
  }): AsyncIterable<ChatStreamEvent>;
}

export interface CreateCoreApiOptions {
  dispatcher: TurnDispatcher;
  routes: ExpressRouteRegistry;
  /**
   * Optional WebSocket registry. When present, the returned CoreApi exposes
   * `registerWebSocket`; when absent, that method is simply not defined so
   * channels feature-detect and non-WS wirings stay untouched.
   */
  webSockets?: WebSocketRegistry;
  log?: (level: LogLevel, message: string, context?: Record<string, unknown>) => void;
}

/**
 * Builds the CoreApi surface a channel plugin receives at activate-time.
 * Every method is channel-scoped via closure — `createCoreApi` is called
 * ONCE globally; per-channel scoping (log prefix, route ownership) happens
 * via the `channelId` the channel passes back.
 */
export function createCoreApi(opts: CreateCoreApiOptions): CoreApi {
  const log = opts.log ?? defaultLog;

  const api: CoreApi = {
    handleTurnStream(turn: IncomingTurn): AsyncIterable<ChatStreamEvent> {
      // Scope the orchestrator turn by the channel-specific conversation id.
      // v1 strategy: `${channelId}::${conversationId}` — stable, unique per
      // chat thread per channel, survives restarts (same mapping yields the
      // same scope, so memory/graph continue to accumulate context).
      const scope = `${turn.channelId}::${turn.conversationId}`;
      // US7 per-binding routing selectors. The adapter MAY set channelType /
      // channelKey explicitly; otherwise the dispatcher derives the type from
      // channelId and the key defaults to the conversation id (the value an
      // operator binds for conversation-scoped channels like Teams).
      const channelKey = turn.channelKey ?? turn.conversationId;
      return opts.dispatcher.streamTurn({
        scope,
        channelId: turn.channelId,
        channelKey,
        ...(turn.channelType ? { channelType: turn.channelType } : {}),
        userRef: turn.userRef,
        text: turn.text,
        ...(turn.metadata ? { metadata: turn.metadata } : {}),
        ...(turn.target !== undefined ? { target: turn.target } : {}),
      });
    },

    registerRoute(
      channelId: string,
      method: HttpMethod,
      path: string,
      handler: RequestHandler,
    ): void {
      opts.routes.register(channelId, method, path, handler);
    },

    registerRouter(channelId: string, prefix: string, router: Router): void {
      opts.routes.registerRouter(channelId, prefix, router);
    },

    async resolveIdentity(ref: ChannelUserRef): Promise<PlatformIdentity> {
      // v1 passthrough — per the design discussion we keep identities
      // ephemeral per channel. Cross-channel merging becomes its own Slice.
      const identity: PlatformIdentity = {
        platformId: `${ref.kind}:${ref.id}`,
        channelUserRef: ref,
      };
      if (ref.displayName !== undefined) {
        identity.displayName = ref.displayName;
      }
      if (ref.email !== undefined) {
        identity.email = ref.email;
      }
      return identity;
    },

    log,
  };

  if (opts.webSockets) {
    const webSockets = opts.webSockets;
    api.registerWebSocket = (
      channelId: string,
      path: string,
      handler: ChannelSocketHandler,
    ): void => {
      webSockets.register(channelId, path, handler);
    };
  }

  return api;
}

function defaultLog(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): void {
  const ctxSuffix = context ? ` ${JSON.stringify(context)}` : '';
  switch (level) {
    case 'error':
      console.error(`[channels] ${message}${ctxSuffix}`);
      break;
    case 'warn':
      console.warn(`[channels] ${message}${ctxSuffix}`);
      break;
    default:
      console.log(`[channels] ${message}${ctxSuffix}`);
  }
}
