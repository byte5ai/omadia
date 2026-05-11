import type { RequestHandler, Router } from 'express';

import type {
  ChatStreamEvent,
  ChannelUserRef,
  CoreApi,
  HttpMethod,
  IncomingTurn,
  LogLevel,
  PlatformIdentity,
} from '@omadia/channel-sdk';
import type { ExpressRouteRegistry } from './routeRegistry.js';

/**
 * Orchestrator adapter the CoreApi delegates to. Intentionally narrow — we
 * don't leak the full Orchestrator class into channels. Slice 2.3 can widen
 * this when Teams actually needs tool-trace or verifier data.
 */
export interface TurnDispatcher {
  streamTurn(input: {
    scope: string;
    userRef: ChannelUserRef;
    text: string;
    metadata?: Record<string, unknown>;
  }): AsyncIterable<ChatStreamEvent>;
}

export interface CreateCoreApiOptions {
  dispatcher: TurnDispatcher;
  routes: ExpressRouteRegistry;
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

  return {
    handleTurnStream(turn: IncomingTurn): AsyncIterable<ChatStreamEvent> {
      // Scope the orchestrator turn by the channel-specific conversation id.
      // v1 strategy: `${channelId}::${conversationId}` — stable, unique per
      // chat thread per channel, survives restarts (same mapping yields the
      // same scope, so memory/graph continue to accumulate context).
      const scope = `${turn.channelId}::${turn.conversationId}`;
      return opts.dispatcher.streamTurn({
        scope,
        userRef: turn.userRef,
        text: turn.text,
        ...(turn.metadata ? { metadata: turn.metadata } : {}),
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
