import type { RequestHandler, Router } from 'express';

import type {
  ChatStreamEvent,
  ChannelSocketHandler,
  ChannelUserRef,
  ConversationMembershipEvent,
  ConversationRosterProvider,
  ConversationSendProvider,
  CoreApi,
  HttpMethod,
  IncomingTurn,
  LogLevel,
  PlatformIdentity,
  TargetedSendProvider,
} from '@omadia/channel-sdk';
import { deriveChannelType } from './channelType.js';
import type { ExpressRouteRegistry } from './routeRegistry.js';
import type { WebSocketRegistry } from './webSocketRegistry.js';
import type { ConversationRosterRegistry } from './rosterRegistry.js';
import type { ConversationEventHub } from './conversationEventHub.js';
import type { TargetedSendRegistry } from './targetedSendRegistry.js';
import type { ConversationSendRegistry } from './conversationSendRegistry.js';

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

/**
 * #1086 — the per-turn routines principal, as far as the channels layer knows
 * it. Deliberately NOT `ManageRoutineContext`: `channels/` must not import
 * `plugins/routines/`, and two fields of that type are none of this layer's
 * business — `tenant` is a deployment value the wiring owns, and
 * `canTargetOthers` (cold-start outreach to OTHER people) is a channel
 * governance decision. The generic producer cannot express the latter at all,
 * which is the point: it can never be turned on by accident.
 */
export interface RoutineTurnInfo {
  /**
   * The tenant the channel declared for this turn (`IncomingTurn.tenantId`).
   * Absent for every classic channel — the wiring then substitutes the
   * deployment tenant, matching what `routes/chat.ts` does for the web chat.
   * Getting this wrong splits routines into buckets that cannot see each
   * other, so there is exactly one defaulting site and it is not here.
   */
  tenant?: string | undefined;
  /**
   * The channel-native user id, VERBATIM. The #1016 owner guard compares this
   * against `ChatTurnInput.userId`, which the dispatcher fills from the same
   * `turn.userRef.id` — canonicalising it here would make the guard refuse
   * every subscription-CLI dispatch.
   */
  userId: string;
  /**
   * Operator-addressable id (email / UPN) when the channel knows one. Used as
   * the Conductor channel-binding key so proactive reminders reach a principal
   * an operator can actually name. Does not affect routine attribution.
   */
  principalRef?: string | undefined;
  /** Short binding type ('teams', 'telegram') — what senders register under. */
  channel: string;
  conversationRef: unknown;
}

/**
 * #1086 — the routines hook the kernel wires in. Optional, like every other
 * capability in this file: without it `handleTurnStream` behaves exactly as
 * before, so a kernel without routines (no Postgres) is untouched.
 */
export interface RoutineTurnScope {
  /**
   * Does a context for THIS user already exist on the async chain?
   *
   * Two cases hide behind this question. A channel adapter that installs its
   * own context (Teams) must win: its `conversationRef` is the Bot Framework
   * handle the proactive sender delivers through, and replacing it with the
   * generic one would create routines that can never be delivered. But
   * `captureRoutineTurn` uses `enterWith`, which has no scope exit (#1016), so
   * a context found here may equally be the PREVIOUS turn's, belonging to
   * someone else. Keying on the user id separates the two: same user ⇒ the
   * adapter's own, richer context stands; different user ⇒ stale, and this
   * turn installs its own scoped one over it.
   */
  hasContextFor(userId: string): boolean;
  /**
   * Open the turn, and return a runner that installs the principal for one
   * async segment of it.
   *
   * Two calls, not one, because a streamed turn has many segments: the
   * dispatcher's generator body resumes on every consumer `next()`, so the
   * runner is invoked once per pull. Anything that must happen ONCE per turn
   * (the Conductor channel binding) belongs in `begin`, never in the runner.
   */
  begin(info: RoutineTurnInfo): <T>(fn: () => Promise<T>) => Promise<T>;
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
  /**
   * #330 B1 — optional group-conversation registries. Each follows the
   * `webSockets` pattern: when absent, the corresponding CoreApi method is
   * simply not defined, so old plugins and non-group wirings stay untouched.
   */
  rosterRegistry?: ConversationRosterRegistry;
  targetedSends?: TargetedSendRegistry;
  conversationEvents?: ConversationEventHub;
  /** #330 C3b — conversation-addressed proactive send (group nudges). */
  conversationSends?: ConversationSendRegistry;
  /**
   * #1086 — routines principal producer. Present only when the routines
   * feature is wired (requires Postgres); absent leaves turns context-free,
   * which is exactly the pre-#1086 behaviour.
   */
  routineTurn?: RoutineTurnScope;
  /**
   * #1086 — resolves a channel id to the short binding type a routine is
   * stored under. The kernel passes the SAME resolver the dispatcher uses, so
   * the manifest's declared `channel_type` wins here too; a plugin whose
   * manifest declares a type that is not the last dotted segment of its id
   * would otherwise have its routines filed under a key no `ProactiveSender`
   * is registered under. Absent ⇒ derived from the channel id alone.
   */
  channelTypeFor?: (channelId: string) => string;
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
      const dispatch = (): AsyncIterable<ChatStreamEvent> =>
        opts.dispatcher.streamTurn({
          scope,
          channelId: turn.channelId,
          channelKey,
          ...(turn.channelType ? { channelType: turn.channelType } : {}),
          userRef: turn.userRef,
          text: turn.text,
          ...(turn.metadata ? { metadata: turn.metadata } : {}),
          ...(turn.target !== undefined ? { target: turn.target } : {}),
        });

      // #1086 — install the routines principal for EVERY channel. Before this,
      // the only producer was the Teams adapter's own `captureRoutineTurn`
      // call, so `manage_routine` refused all five actions everywhere else —
      // including the two channels shipped in this repo (public API, canvas).
      // This method is the single door every channel plugin goes through, so
      // it is the one place the context can be produced once for all of them.
      const routineTurn = opts.routineTurn;
      // A blank user id is not a principal. Installing one would ALSO break the
      // turn beyond routines: the #1016 owner guard refuses whenever a context
      // is present but its userId does not equal the turn's, and it normalises
      // a blank id to `undefined` on both sides — so a context with `userId: ''`
      // fails its comparison and throws on every loopback CLI dispatch. The
      // guard's documented "absent context ⇒ pass" row is the correct outcome
      // for an anonymous turn, and skipping here is what preserves it.
      const principal = turn.userRef.id.trim();
      if (!routineTurn || !principal || routineTurn.hasContextFor(turn.userRef.id)) {
        return dispatch();
      }
      // A blank tenant is not a tenant: forwarding `''` would file the routine
      // in a bucket nothing else can see, and `??` at the wiring's defaulting
      // site would not catch it.
      const declaredTenant = turn.tenantId?.trim();
      return withRoutineTurnScope(
        routineTurn,
        {
          ...(declaredTenant ? { tenant: declaredTenant } : {}),
          userId: turn.userRef.id,
          ...(turn.userRef.email ? { principalRef: turn.userRef.email } : {}),
          // The routine is stored against the SHORT binding type, because that
          // is what a channel plugin registers its ProactiveSender under
          // ('telegram'), not the reverse-DNS catalog id.
          // Normalised the way `deriveChannelType` normalises, and truthy-tested
          // like the dispatch selector above: a blank `channelType` must fall
          // through rather than file the routine under '', and a 'Teams' must
          // find the sender registered as 'teams' (the registry is an
          // exact-match Map).
          channel:
            turn.channelType?.trim().toLowerCase() ||
            opts.channelTypeFor?.(turn.channelId) ||
            deriveChannelType(turn.channelId),
          // The channel-native delivery handle is the adapter's to give (it is
          // why an adapter-installed context wins above). All this layer can
          // honestly offer is the pair that identifies the thread.
          conversationRef: {
            kind: 'channel',
            channelId: turn.channelId,
            conversationId: turn.conversationId,
          },
        },
        dispatch,
      );
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

  // #330 B1 — optional group-conversation capabilities, defined only when the
  // kernel wired the matching registry (the registerWebSocket pattern).
  if (opts.rosterRegistry) {
    const rosters = opts.rosterRegistry;
    api.registerRosterProvider = (channelId: string, provider: ConversationRosterProvider): void => {
      rosters.register(channelId, provider);
    };
  }
  if (opts.targetedSends) {
    const targetedSends = opts.targetedSends;
    api.registerTargetedSendProvider = (channelId: string, provider: TargetedSendProvider): void => {
      targetedSends.register(channelId, provider);
    };
  }
  if (opts.conversationEvents) {
    const conversationEvents = opts.conversationEvents;
    api.emitConversationEvent = (event: ConversationMembershipEvent): void => {
      conversationEvents.emit(event);
    };
  }
  if (opts.conversationSends) {
    const conversationSends = opts.conversationSends;
    api.registerConversationSendProvider = (channelId: string, provider: ConversationSendProvider): void => {
      conversationSends.register(channelId, provider);
    };
  }

  return api;
}

/**
 * #1086 — run an orchestrator stream inside the routines principal.
 *
 * `routineTurnContext.run()` does not drop in around the call: this method
 * returns an AsyncIterable, not a promise, so wrapping the call would only
 * cover the synchronous construction of the iterator. The dispatcher's
 * generator body suspends at every `yield` and resumes on the CONSUMER's
 * `next()` — outside that scope, where the context would be gone again.
 *
 * So each pull is wrapped instead. That keeps the whole turn inside the scope
 * AND keeps the scope exit, which is the half `captureRoutineTurn` is missing:
 * it uses `enterWith`, whose value leaks forward on the async chain and became
 * the staleness #1016 had to build a guard against. Nothing leaks here.
 */
function withRoutineTurnScope(
  scope: RoutineTurnScope,
  info: RoutineTurnInfo,
  dispatch: () => AsyncIterable<ChatStreamEvent>,
): AsyncIterable<ChatStreamEvent> {
  // Both opened lazily on the first pull, together: `begin` carries the turn's
  // once-per-turn work, so a stream nobody ever reads must not trigger it, and
  // an async generator's body does not start until the first `next()` anyway.
  let run: (<T>(fn: () => Promise<T>) => Promise<T>) | undefined;
  let inner: AsyncIterator<ChatStreamEvent> | undefined;

  const iterator: AsyncIterator<ChatStreamEvent> = {
    next: () => {
      run ??= scope.begin(info);
      return run(async () => {
        inner ??= dispatch()[Symbol.asyncIterator]();
        return inner.next();
      });
    },
    // A consumer that breaks early (the canvas channel does) must still close
    // the orchestrator stream, or its `finally` cleanup never runs. Closing
    // happens inside the scope too: that cleanup is still part of the turn and
    // may touch the same per-turn state the body did. Closing or throwing
    // BEFORE the first pull opens nothing — there is no turn to scope, and
    // opening one would write a Conductor binding for a turn that never ran.
    return: async (value?: unknown) => {
      if (!run) return { done: true, value: undefined };
      return run(async () => {
        const result = await inner?.return?.(value);
        return result ?? { done: true, value: undefined };
      });
    },
    throw: async (err?: unknown) => {
      if (!run) throw err;
      return run(async () => {
        if (inner?.throw) return inner.throw(err);
        throw err;
      });
    },
  };

  // ONE iterator, handed out on every `[Symbol.asyncIterator]()` call — an
  // async generator returns `this` too. Building fresh state per call would
  // turn a second `for await` over the same value into a SECOND orchestrator
  // turn (a second model run, a second reply) where the dispatcher's own
  // generator would have reported `done` immediately.
  return { [Symbol.asyncIterator]: () => iterator };
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
