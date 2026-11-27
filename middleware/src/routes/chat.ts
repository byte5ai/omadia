import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  ANSWER_VERBOSITY_LEVELS,
  formatPrincipal,
  isNoReply,
  logNoReplyDrop,
  makePrincipal,
  parseAgentCommand,
  suppressNoReplyStream,
  type AgentCommand,
} from '@omadia/channel-sdk';
import { SYSTEM_SPEAKER, type AgentSpeaker, type SystemNotice } from '@omadia/plugin-api';
import { MAX_STEER_LENGTH, steeringBus, today, turnContext, webAccountOrigin } from '@omadia/orchestrator';
import type {
  AskObserver,
  ChatAgent,
  ChatSessionStore,
  TurnContextValue,
} from '@omadia/orchestrator';

import type { AgentResolver } from '../agents/resolveAgentForTool.js';
import { mayUseChatSession, type LegacyChatOwner } from './chatSessionAccess.js';
import { sessionIdentity } from '../auth/sessionIdentity.js';
import { recordForeignToolCall } from '../platform/foreignToolMetrics.js';
import {
  recordTurnFailure,
  recordTurnSuccess,
} from '../platform/lastTurnOutcome.js';
import type { ManageRoutineContext } from '../plugins/routines/manageRoutineTool.js';
import { routineTurnContext } from '../plugins/routines/routineTurnContext.js';
import { routineDeliveriesHint } from '../plugins/routines/routineDeliveryContext.js';
import {
  WEB_ROUTINE_CHANNEL,
  webChatConversationRef,
} from '../plugins/routines/webChatProactiveSender.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const AGENT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Heartbeat cadence for `/chat/stream`. Mirrors the builder route's 2s pulse
 * (see BUILDER_HEARTBEAT_INTERVAL_MS in builderAgent.ts) so the front-ends
 * can share the liveness-rendering thresholds.
 */
const CHAT_HEARTBEAT_INTERVAL_MS = 2000;

const ChatRequestSchema = z.object({
  message: z.string().min(1, 'message must be a non-empty string'),
  /** Optional free-form scope for transcript bucketing — e.g. 'cli-john'. */
  scope: z.string().min(1).max(120).optional(),
  /**
   * Optional persisted chat-tab id. When present it becomes the orchestrator's
   * sessionScope directly (no `http-` prefix), so the knowledge graph maps each
   * tab to exactly one Session node. Explicit `scope` still wins if both are
   * set — the caller is overriding session correlation for debug reasons.
   */
  sessionId: z
    .string()
    .regex(SESSION_ID_RE, 'sessionId must match [A-Za-z0-9_-]{1,80}')
    .optional(),
  /**
   * Phase A — optional Agent slug. Only the FIRST turn of a session
   * uses this; subsequent turns reuse the snapshotted slug. Sending a
   * different slug than the pinned one ⇒ 409 agent_mismatch.
   */
  agentSlug: z
    .string()
    .regex(AGENT_SLUG_RE, 'agentSlug must be lowercase-kebab')
    .optional(),
  /**
   * Phase 3 — answer-size pick for THIS turn only ("Kürzer" / "Mehr Details"
   * re-asking the same question). Validated against the closed scale here
   * and parsed again by the kernel; `null`/absent = the configured level.
   */
  answerVerbosity: z.enum(ANSWER_VERBOSITY_LEVELS).optional(),
});

/**
 * The orchestrator `sessionScope` for an HTTP turn.
 *
 * W5 memory-ACL (#860), coordinator decision 1 — the scope is never a memory
 * partition. Since #1774 (ADR-0182) the turn's origin comes from the signed-in
 * account instead (`webTurnOrigin`), never from what this function returns.
 *
 * The scopes this function returns (`http-<scope>`, a client-chosen
 * `sessionId`, or the shared literal `'http-default'`) are transcript-bucketing
 * labels supplied by the CALLER. Deriving a memory partition from them would
 * hand any API client the ability to name — and therefore to read — another
 * caller's memory tier by sending its scope string, and `'http-default'` would
 * make one shared tier out of every unlabelled turn. An API caller gets no
 * implicit team or channel memory; when a genuine tenant identity exists on
 * this surface it has to be resolved from the authenticated principal and
 * passed as an explicit `origin`, which is a change to make deliberately, not
 * to inherit from a debug label.
 */
function resolveScope(parsed: z.infer<typeof ChatRequestSchema>): string {
  if (parsed.scope) return `http-${parsed.scope}`;
  if (parsed.sessionId) return parsed.sessionId;
  return 'http-default';
}

/**
 * Mid-turn steering request. Same `scope`/`sessionId` correlation fields as a
 * chat turn (so it resolves to the identical session scope via `resolveScope`),
 * plus the message to inject into the live turn.
 */
const SteerRequestSchema = z.object({
  message: z.string().min(1, 'message must be a non-empty string').max(MAX_STEER_LENGTH),
  scope: z.string().min(1).max(120).optional(),
  sessionId: z
    .string()
    .regex(SESSION_ID_RE, 'sessionId must match [A-Za-z0-9_-]{1,80}')
    .optional(),
});

const USER_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

/**
 * Pulls a user identity from the request. Resolution order:
 *
 *   1. `req.session.omadia_user_id` — set by `requireAuth` once the
 *      session JWT was minted with the Slice 1b-channel-web cluster
 *      resolver wired (browser flow via Admin UI login). This is the
 *      cluster-root id `ingestRun` expects.
 *   2. `x-user-id` header — legacy path for HTTP callers and channel
 *      adapters (Teams sets the AAD object id; tests set arbitrary
 *      strings). Treated as advisory metadata only — `ingestRun`
 *      currently rejects unresolved ids, so without the cluster being
 *      pre-created elsewhere this fall through ends up anonymous.
 *
 * Invalid or oversize values are ignored rather than thrown — identity
 * is never an auth claim at this layer.
 */
function resolveUserId(req: Request): string | undefined {
  const sessionId = req.session?.omadia_user_id;
  if (sessionId && USER_ID_RE.test(sessionId)) return sessionId;
  const raw = req.header('x-user-id');
  if (!raw) return undefined;
  return USER_ID_RE.test(raw) ? raw : undefined;
}

/**
 * #1774 (ADR-0182) — the turn's origin: the signed-in account's one-person
 * room, from the session's canonical omadia user id only (never the
 * `x-user-id` header, the scope or the `sessionId`, which the caller picks).
 * Absent without such a session: the turn stays context-free.
 */
function webTurnOrigin(req: Request): { origin?: ReturnType<typeof webAccountOrigin> } {
  const id = req.session?.omadia_user_id;
  if (!id || !USER_ID_RE.test(id)) return {};
  return { origin: webAccountOrigin(id) };
}

/**
 * W4-1 — the missing `mcpUserKey` PRODUCER for the HTTP chat paths.
 *
 * Migration 0031 made MCP delegation explicit per server. A `per_user` server
 * resolves its OAuth token under the CALLER's identity, which the auth provider
 * in `src/index.ts` reads as `turnContext.current()?.mcpUserKey`. The MCP
 * discover route set that; the chat routes never did, so every `per_user`
 * server was unreachable from chat: no token was sent, the audit row recorded
 * the literal `unresolved`, and the turn failed closed with
 * `delegationBlockedMessage`. New servers default to `per_user`, so every
 * newly-created server was broken out of the box.
 *
 * The scope established here is the OUTER one; the orchestrator opens its own
 * turn scope and carries `mcpUserKey` over from this parent.
 *
 * Two deliberate non-decisions:
 *
 *  - The value is `sessionIdentity(req)`, NOT `resolveUserId(req)`. The latter
 *    reads `req.session.omadia_user_id` and falls through to the CLIENT-SENT
 *    `x-user-id` header; keying MCP tokens on a client-controlled header would
 *    let any caller act as any user. `mcpUserKey` is the OAuth-shaped identity
 *    the token table is actually keyed on.
 *  - When no identity resolves, `mcpUserKey` is left UNSET. There is no
 *    fallback. A `per_user` server then fails closed exactly as W0-1 intends;
 *    inventing a substitute is the confused deputy that fix closed.
 */
/**
 * #1756 — the labelled block of the chat's recent routine deliveries, or
 * undefined (no saved chat, no store, none delivered). A store failure only
 * loses the block, never the turn.
 */
async function routineDeliveriesFor(
  options: Pick<CreateChatRouterOptions, 'getChatSessionStore' | 'chatSessionStore' | 'timeZone'>,
  sessionId: string | undefined,
): Promise<string | undefined> {
  const store = options.getChatSessionStore?.() ?? options.chatSessionStore;
  if (!sessionId || !store) return undefined;
  const session = await store.get(sessionId).catch(() => null);
  return session ? routineDeliveriesHint(session.messages, options.timeZone) : undefined;
}

function chatTurnContext(req: Request, sessionScope: string): TurnContextValue {
  const identity = sessionIdentity(req);
  return {
    // Placeholder ids: the orchestrator overwrites both in its own inner turn
    // scope and carries only `mcpUserKey` across. Kept descriptive so a stray
    // log line from this scope is still attributable.
    turnId: `http-chat-${sessionScope}`,
    // #1921 — a tool that runs in this scope (subscription CLI, fast path)
    // is not audited under the placeholder.
    turnIdIsPlaceholder: true,
    turnDate: today(),
    ...(identity ? { mcpUserKey: identity } : {}),
  };
}

/**
 * OM-82 (#993, #1016) — the missing PRODUCER of the routines principal.
 *
 * `#993` taught the loopback dispatch to restore the caller's async context
 * across the CLI process boundary and `#1016` taught it to refuse a stale one.
 * Both hardened the transport of a value the HTTP chat route never installed:
 * at the time, the only writer of `routineTurnContext` in the whole tree was
 * `RoutinesIntegration.captureRoutineTurn`, which only the out-of-tree Teams
 * adapter calls. So on the web chat `routineTurnContext.current()` was
 * `undefined` for the entire turn and `manage_routine` refused every action.
 *
 * #1086 closed the same gap for channel plugins, in `CoreApi.handleTurnStream`.
 * This producer stays: the web chat is an HTTP route, not a channel plugin, and
 * it does not go through that method. It also resolves a principal the core
 * cannot — the server-side session, see below.
 *
 * Returns `undefined` when no principal resolved. That is deliberate: the
 * `#1016` owner guard REFUSES a dispatch whose restored context has a userId
 * the turn does not, so installing an anonymous context would turn a graceful
 * "no user context" into a hard guard failure.
 *
 * The identity is the SESSION's, never `resolveUserId(req)` — for the reason
 * `chatTurnContext` already documents above. `resolveUserId` falls through to
 * the client-sent `x-user-id` header, and `manage_routine` scopes `pause` /
 * `resume` / `delete` to the context's `(tenant, userId)` (#1025), so keying
 * the principal on that header would let any caller name a victim and manage
 * their routines. The `#1016` guard cannot catch it either: both sides of its
 * comparison would come from the same forged header and would match.
 *
 * #1071 — the channel is `'web'`, which the kernel backs with the web chat's
 * own proactive sender (`webChatProactiveSender.ts`, registered with the
 * routines feature when Postgres is configured): a routine created here
 * delivers its output into the chat it was created in. Without Postgres the
 * routines feature — and so `manage_routine` — is not wired at all.
 *
 * #1598 — `agentSlug` is the orchestrator the turn resolved to (pinned
 * snapshot, request slug or platform fallback). `manage_routine` refuses
 * `create` without it whenever an orchestrator registry is wired, which is
 * every real deployment — so omitting it made web-chat routines impossible.
 */
function httpRoutineContext(
  req: Request,
  body: z.infer<typeof ChatRequestSchema>,
  agentSlug: string,
): ManageRoutineContext | undefined {
  const userId = req.session?.omadia_user_id;
  if (!userId || !USER_ID_RE.test(userId)) return undefined;
  return {
    tenant: process.env['GRAPH_TENANT_ID'] ?? 'default',
    userId,
    channel: WEB_ROUTINE_CHANNEL,
    // #1071 — the delivery handle names the persisted chat the web sender
    // appends the routine's output to. The sessionId is captured only when it
    // IS the turn's scope: under a debug `scope` the turn is bucketed
    // elsewhere, and without a sessionId there is no chat to deliver into —
    // the web sender then refuses `create` with a message saying so.
    conversationRef: webChatConversationRef(
      resolveScope(body),
      body.scope ? undefined : body.sessionId,
    ),
    // Cold-start outreach to OTHER people is a channel-governance decision; the
    // web chat has no such governance source, so it stays closed.
    canTargetOthers: false,
    agentSlug,
  };
}

/** Run `fn` under the routines principal when one resolved, unchanged otherwise. */
function withRoutinePrincipal<T>(
  ctx: ManageRoutineContext | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return ctx ? routineTurnContext.run(ctx, fn) : fn();
}

/**
 * NDJSON framing: one JSON event per line. Easier to parse than SSE, works
 * with a plain fetch+ReadableStream on the browser side, and survives any
 * reverse proxy that handles chunked responses correctly.
 */
/**
 * #1008 — is this `tool_use` event flagged foreign?
 *
 * Read structurally rather than off the `ChatStreamEvent` union on purpose.
 * The flag is set by `cliChatAgent` and declared on the channel-sdk event
 * type, but this route resolves that type through the built package: a tree
 * whose `dist/` predates the declaration would fail to compile against a
 * direct `event.foreign`, which is a build-order accident, not a contract
 * change. The wire contract is "the property is present and true", and that
 * is exactly what this asks.
 */
function isForeignToolUse(event: object): boolean {
  return (event as { foreign?: unknown }).foreign === true;
}

function writeEvent(res: Response, event: unknown): void {
  res.write(`${JSON.stringify(event)}\n`);
}

export interface CreateChatRouterOptions {
  /** #1756 — the zone routine delivery times are named in (`PROACTIVE_TIMEZONE`). */
  timeZone?: string;
  /** Resolves tool names to installed-agent metadata so `tool_use` events
   *  carry agent pills for the UI. Optional — when absent (e.g. in tests),
   *  events are forwarded unchanged. */
  agentResolver?: AgentResolver;
  /**
   * #2055 — the management layer's decision for one web chat turn: the
   * agent that answers (explicitly chosen, else the sender's default agent
   * for the web channel), or the `system` notice the sender gets instead.
   * Never another agent.
   */
  routeTurn: (request: WebRouteRequest) => WebRouteResult;
  /**
   * #2055 — carries out `/agent <name>`, `/agent`, `/agents` typed in the web
   * chat: stores the sender's selection for this conversation and returns
   * the `system` notice. Absent: the command is ordinary text.
   */
  handleAgentCommand?: (command: AgentCommand, request: Omit<WebRouteRequest, 'explicitSlug'>) => Promise<SystemNotice>;
  /** OM-76 (#996) — is ANY Agent active right now? When this answers `false`
   *  the 503 carries `no_agents_active` instead of `agent_unavailable`: the
   *  requested slug is not "deleted or disabled", there simply is no
   *  agent running (none exists or is enabled, or no LLM provider). The UI
   *  must not offer "re-bind to default" in that state — the default is the
   *  very thing that is missing. Optional so older mounts keep the old code. */
  hasActiveAgents?: () => boolean;
  /** #2314 — the id of the live agent holding `slug`, or undefined. A
   *  session pinned to another id was opened with a deleted agent whose slug
   *  was reused; its turns are refused (503 `agent_unavailable`). */
  agentIdForSlug?: (slug: string) => string | undefined;
  /** Phase A — chat session store, for snapshot capture on the first
   *  turn of a session. */
  chatSessionStore?: ChatSessionStore;
  /** Live resolver for the chat session store. Preferred over the static
   *  `chatSessionStore` so the store is picked up when the orchestrator
   *  plugin publishes it post-boot (LLM-access-page key entry) without a
   *  restart. Falls back to `chatSessionStore` when absent. */
  getChatSessionStore?: () => ChatSessionStore | undefined;
  /** #1762 — owner of chats written before owners existed (`chatSessionAccess.ts`). */
  legacyChatOwner?: LegacyChatOwner;
  /** Phase A — builds a SessionConfigSnapshot for a given Agent slug.
   *  Same shape as `OrchestratorRegistry.snapshotForAgent`. */
  snapshotForAgent?: (slug: string) =>
    | {
        agentSlug: string;
        agentId?: string;
        pluginIds: string[];
        toolIds: string[];
        memoryScope: string[];
        capturedAt: number;
      }
    | undefined;
}

/** #2055 — what the chat route asks the management layer. */
export interface WebRouteRequest {
  /** The agent the conversation is pinned to or the sender chose. */
  readonly explicitSlug?: string;
  /** The sender, `user:<id>`. */
  readonly principal?: string;
  /** The conversation: `session:<id>`, or the shared HTTP scope. */
  readonly conversationKey: string;
  readonly locale?: string;
}

export type WebRouteResult =
  | {
      readonly kind: 'agent';
      readonly chatAgent: ChatAgent;
      readonly slug: string;
      readonly speaker: AgentSpeaker;
    }
  | { readonly kind: 'notice'; readonly notice: SystemNotice };

type ResolvedTurn =
  | { readonly kind: 'agent'; readonly chatAgent: ChatAgent; readonly effectiveSlug: string; readonly speaker: AgentSpeaker }
  | { readonly kind: 'notice'; readonly notice: SystemNotice };

/**
 * #2055 — `/agent …` typed in the web chat is the management layer's, never
 * an agent turn, and never pins the session. Choosing or clearing an agent
 * also releases the session's pin, so the next message routes by the new
 * selection (explicit addressing would otherwise keep the old agent).
 */
async function handleWebAgentCommand(
  req: Request,
  message: string,
  sessionId: string | undefined,
  options: CreateChatRouterOptions,
): Promise<SystemNotice | undefined> {
  const command = options.handleAgentCommand ? parseAgentCommand(message) : undefined;
  if (!command || !options.handleAgentCommand) return undefined;
  const principal = webPrincipal(req);
  const notice = await options.handleAgentCommand(command, {
    ...(principal ? { principal } : {}),
    conversationKey: sessionId ? `session:${sessionId}` : 'http-default',
    locale: webLocale(req),
  });
  const sessionStore = options.getChatSessionStore?.() ?? options.chatSessionStore;
  const changed = notice.code === 'agent_selected' || notice.code === 'agent_selection_cleared';
  if (changed && sessionId && sessionStore) {
    await sessionStore.clearSnapshot(sessionId);
  }
  return notice;
}

/** The web channel's type in the routing tables (default-agent entries, availability). */
export const WEB_CHANNEL_TYPE = 'web';

/**
 * #2055 — the sender as a principal. The e-mail first, the way channel
 * plugins name a person, so a default-agent entry for `user:anna@co.com`
 * matches Anna in the web chat and in Teams alike.
 */
function webPrincipal(req: Request): string | undefined {
  const ref = req.session?.email || req.session?.sub;
  const principal = ref ? makePrincipal('user', ref) : undefined;
  return principal ? formatPrincipal(principal) : undefined;
}

function webLocale(req: Request): string {
  return req.acceptsLanguages('de', 'en') || 'de';
}

/**
 * OM-76 — the registry holds no running agent. Two causes look the same from
 * here: no agent exists or is enabled, or no LLM provider is assigned to it.
 * The message names both, never only one of them.
 */
export const NO_AGENTS_ACTIVE_MESSAGE =
  'no agent is active: create or enable an agent under Agents, and make sure an LLM provider (API key or subscription CLI) is assigned under LLM access.';

/**
 * Phase A / #2055 — per-request agent resolution. Returns the agent that
 * answers, the `system` notice the sender gets instead, or sends an HTTP
 * error and returns `undefined`. The caller uses the returned slug to capture
 * a snapshot on the first turn.
 */
async function resolveAgentForRequest(
  req: Request,
  res: Response,
  requestSlug: string | undefined,
  sessionId: string | undefined,
  options: CreateChatRouterOptions,
  message: string,
): Promise<ResolvedTurn | undefined> {
  // #1762 — a turn in another account's chat would read its tail, pin its
  // agent and append to it. It answers like a missing chat.
  if (sessionId && !(await mayUseOwnChat(req, sessionId, options))) {
    res.status(404).json({ error: 'not_found', message: `chat session ${sessionId} not found` });
    return undefined;
  }
  const commandNotice = await handleWebAgentCommand(req, message, sessionId, options);
  if (commandNotice) return { kind: 'notice', notice: commandNotice };

  // 1. If session has a pinned snapshot, use it (and reject mismatches).
  let pinnedSlug: string | undefined;
  const sessionStore = options.getChatSessionStore?.() ?? options.chatSessionStore;
  if (sessionId && sessionStore) {
    const session = await sessionStore.get(sessionId);
    pinnedSlug = session?.snapshot?.agentSlug;
    if (pinnedSlug && requestSlug && requestSlug !== pinnedSlug) {
      res.status(409).json({
        error: 'agent_mismatch',
        message: `session ${sessionId} is pinned to "${pinnedSlug}" — request slug "${requestSlug}" rejected`,
        pinned_slug: pinnedSlug,
      });
      return undefined;
    }
    // #2314 (ADR-0218) — the pinned agent was deleted and a new agent took
    // its slug: the old tab must not talk to the new agent with the old
    // transcript. The web chat shows its recovery banner for this answer.
    const pinnedId = session?.snapshot?.agentId;
    if (pinnedSlug && pinnedId && options.agentIdForSlug) {
      const liveId = options.agentIdForSlug(pinnedSlug);
      if (liveId !== undefined && liveId !== pinnedId) {
        res.status(503).json({
          error: 'agent_unavailable',
          reason: 'agent_deleted',
          message: `the agent this chat was opened with was deleted; "${pinnedSlug}" is now another agent`,
          slug: pinnedSlug,
        });
        return undefined;
      }
    }
  }

  if (options.hasActiveAgents?.() === false) {
    res.status(503).json({
      error: 'no_agents_active',
      message: NO_AGENTS_ACTIVE_MESSAGE,
    });
    return undefined;
  }

  const explicitSlug = pinnedSlug ?? requestSlug;
  const principal = webPrincipal(req);
  const routed = options.routeTurn({
    ...(explicitSlug ? { explicitSlug } : {}),
    ...(principal ? { principal } : {}),
    conversationKey: sessionId ? `session:${sessionId}` : 'http-default',
    locale: webLocale(req),
  });
  if (routed.kind === 'notice') return routed;
  return { kind: 'agent', chatAgent: routed.chatAgent, effectiveSlug: routed.slug, speaker: routed.speaker };
}

function mayUseOwnChat(req: Request, sessionId: string, options: CreateChatRouterOptions): Promise<boolean> {
  const store = options.getChatSessionStore?.() ?? options.chatSessionStore;
  return mayUseChatSession(req, store, sessionId, options.legacyChatOwner);
}

export function createChatRouter(
  options: CreateChatRouterOptions,
): Router {
  const router = Router();
  const { agentResolver } = options;

  router.post('/chat', async (req: Request, res: Response) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }

    const resolved = await resolveAgentForRequest(
      req,
      res,
      parsed.data.agentSlug,
      parsed.data.sessionId,
      options,
      parsed.data.message,
    );
    if (!resolved) return;
    if (resolved.kind === 'notice') {
      // INV-6/7 — the management layer speaks, as `system`, never an agent.
      res.json({
        answer: resolved.notice.text,
        speaker: SYSTEM_SPEAKER,
        systemNotice: resolved.notice,
      });
      return;
    }
    const { chatAgent: chat, effectiveSlug, speaker } = resolved;

    try {
      const userId = resolveUserId(req);
      const sessionScope = resolveScope(parsed.data);
      // #1756 — routine output delivered into this chat is part of it.
      const deliveriesHint = await routineDeliveriesFor(options, parsed.data.sessionId);
      // W4-1: the whole turn runs inside the identity scope. `run` (not
      // `enter`) because a plain async call's own async chain bounds it.
      // OM-82: the routines principal wraps it on the OUTSIDE, so the CLI
      // bridge's `AsyncLocalStorage.snapshot()` captures both.
      const result = await withRoutinePrincipal(
        httpRoutineContext(req, parsed.data, effectiveSlug),
        () =>
          turnContext.run(chatTurnContext(req, sessionScope), () =>
            chat.chat({
              userMessage: parsed.data.message,
              sessionScope,
              ...(userId ? { userId } : {}),
              ...webTurnOrigin(req),
              ...(deliveriesHint ? { conversationContextHint: deliveriesHint } : {}),
              ...(parsed.data.answerVerbosity
                ? { answerVerbosity: parsed.data.answerVerbosity }
                : {}),
            }),
          ),
      );
      // OM-100b: a turn that came back is the only proof the runtime works.
      recordTurnSuccess();
      // Snapshot capture (Phase A) — first turn pins the session to the
      // resolved Agent. Subsequent turns use the pinned snapshot via
      // resolveAgentForRequest above; this is a no-op then.
      const snapStore = options.getChatSessionStore?.() ?? options.chatSessionStore;
      if (parsed.data.sessionId && snapStore) {
        await snapStore
          .captureSnapshot(parsed.data.sessionId, () => {
            const snap = options.snapshotForAgent?.(effectiveSlug);
            return Promise.resolve(
              snap ?? {
                agentSlug: effectiveSlug,
                pluginIds: [],
                toolIds: [],
                memoryScope: [],
                capturedAt: Date.now(),
              },
            );
          })
          .catch((err) => {
            console.warn(
              `[chat] captureSnapshot failed for session ${parsed.data.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
      if (isNoReply(result)) {
        logNoReplyDrop('http', { sessionScope, userId });
        res.json({ answer: '' });
        return;
      }
      // `answer` preserved for legacy dev-UI compat; telemetry counts moved
      // to the run-trace side-channel (ChatAgent.chat returns the channel-
      // agnostic SemanticAnswer shape now, no toolCalls/iterations exposed).
      res.json({
        answer: result.text,
        agent_slug: effectiveSlug,
        speaker: result.speaker ?? speaker,
        ...(result.systemNotice ? { systemNotice: result.systemNotice } : {}),
        ...(result.privacyReceipt
          ? { privacyReceipt: result.privacyReceipt }
          : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[chat] orchestrator failure:', err);
      // OM-100b: classify before responding so the status card can name the
      // remedy (e.g. `cli_incompatible` → update the CLI) instead of echoing.
      const outcome = recordTurnFailure(err);
      res
        .status(500)
        .json({ error: 'orchestrator_failure', code: outcome.errorCode, message });
    }
  });

  router.post('/chat/stream', async (req: Request, res: Response) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }

    // Resolve BEFORE setting NDJSON headers — error responses on the
    // routing path want JSON status codes, not a streamed event.
    const resolved = await resolveAgentForRequest(
      req,
      res,
      parsed.data.agentSlug,
      parsed.data.sessionId,
      options,
      parsed.data.message,
    );
    if (!resolved) return;

    // NDJSON streaming. `X-Accel-Buffering: no` disables nginx response
    // buffering if the middleware ever sits behind one; harmless locally.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    if (resolved.kind === 'notice') {
      // INV-6/7 — no agent answers: the turn is the management layer's
      // notice, with speaker `system`. No model runs.
      writeEvent(res, {
        type: 'done',
        answer: resolved.notice.text,
        toolCalls: 0,
        iterations: 0,
        speaker: SYSTEM_SPEAKER,
        systemNotice: resolved.notice,
      });
      res.end();
      return;
    }
    const { chatAgent: chat, effectiveSlug, speaker } = resolved;

    // Detect premature client disconnect via the response's 'close' event.
    // We intentionally *don't* listen on req.on('close') — on Node 22 / Express 5
    // that fires when the request body is fully read, which is immediately
    // after body parsing for POSTs, and would cause us to bail before writing
    // the first event. `res.on('close')` fires only when the socket actually
    // closes, and we distinguish "we ended it" from "client hung up" via
    // `res.writableEnded`.
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) clientGone = true;
    });

    // Theme E0 + E1 liveness state. The heartbeat timer reads these to
    // compose its event; observer hooks + tool yields update them. All
    // counters reset on each `iteration_start` so the `tokensThisIter`
    // figure reflects the current iteration only.
    let lastActivityAt = Date.now();
    let currentIteration = 0;
    let toolCallsThisIter = 0;
    let phase: 'thinking' | 'streaming' | 'tool_running' | 'idle' = 'idle';
    let tokensStreamedThisIter = 0;
    /**
     * #1008 — tool_use ids the CLI agent flagged `foreign`, so the matching
     * `tool_result` can be stamped too. Without this the pair is
     * inconsistent: the call is marked and its result looks like any other,
     * which is exactly the ambiguity OM-81 set out to remove. Bounded by the
     * tool calls of ONE turn, and the whole handler scope dies with the
     * response, so there is nothing to evict.
     */
    const foreignToolUseIds = new Set<string>();
    const safeWrite = (event: unknown): void => {
      if (!clientGone) writeEvent(res, event);
    };

    const observer: AskObserver = {
      onIteration({ iteration }) {
        currentIteration = iteration;
        toolCallsThisIter = 0;
        tokensStreamedThisIter = 0;
        lastActivityAt = Date.now();
      },
      onIterationPhase({ phase: nextPhase }) {
        phase = nextPhase;
        lastActivityAt = Date.now();
      },
      onTokenChunk({
        iteration,
        deltaTokens,
        cumulativeOutputTokens,
        tokensPerSec,
      }) {
        tokensStreamedThisIter = cumulativeOutputTokens;
        lastActivityAt = Date.now();
        safeWrite({
          type: 'stream_token_chunk',
          iteration,
          deltaTokens,
          cumulativeOutputTokens,
          tokensPerSec,
        });
      },
      onIterationUsage({
        iteration,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
      }) {
        lastActivityAt = Date.now();
        safeWrite({
          type: 'iteration_usage',
          iteration,
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens,
        });
      },
    };

    const heartbeatTimer = setInterval(() => {
      safeWrite({
        type: 'heartbeat',
        sinceLastActivityMs: Date.now() - lastActivityAt,
        currentIteration,
        toolCallsThisIter,
        phase,
        tokensStreamedThisIter,
      });
    }, CHAT_HEARTBEAT_INTERVAL_MS);
    // Don't keep the event loop alive just for the heartbeat — when the
    // turn is done we clear the interval explicitly in finally{}.
    heartbeatTimer.unref?.();

    try {
      const userId = resolveUserId(req);
      // Snapshot capture on first turn (Phase A) — fire-and-forget; failure
      // logged but does not block streaming.
      const snapStore = options.getChatSessionStore?.() ?? options.chatSessionStore;
      if (parsed.data.sessionId && snapStore) {
        void snapStore
          .captureSnapshot(parsed.data.sessionId, () => {
            const snap = options.snapshotForAgent?.(effectiveSlug);
            return Promise.resolve(
              snap ?? {
                agentSlug: effectiveSlug,
                pluginIds: [],
                toolIds: [],
                memoryScope: [],
                capturedAt: Date.now(),
              },
            );
          })
          .catch((err) => {
            console.warn(
              `[chat] captureSnapshot failed for session ${parsed.data.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
      // Emit a header event so the UI can render the bound Agent slug
      // before the first token lands.
      safeWrite({ type: 'agent_bound', slug: effectiveSlug, speaker });

      // OM-82: `run`, not `enter`. `turnContext` needs `runGenerator` because
      // ITS generator is created inside the orchestrator and resumed by
      // whoever calls `.next()`; this one is created AND drained right here,
      // inside the scope below, so a plain `run` covers every `.next()` and
      // still exits cleanly. `enterWith` would leave the principal on this
      // request's async chain with no scope exit — a leak the in-process
      // runtime has no owner guard to catch (#1016 guards the CLI agent only).
      const routinePrincipal = httpRoutineContext(req, parsed.data, effectiveSlug);
      // OM-100b: an error EVENT ends the stream normally — neither runtime
      // throws for a failed turn — so the outcome has to be read off the wire.
      let streamError: string | undefined;
      // #1756 — routine output delivered into this chat is part of it.
      const deliveriesHint = await routineDeliveriesFor(options, parsed.data.sessionId);
      await withRoutinePrincipal(routinePrincipal, async () => {
      // W4-1: `runGenerator`, NOT `run`/`enter`. `enterWith` binds the store to
      // the async resource executing at that instant, and an async generator is
      // resumed in the async context of whoever called `.next()` — so the
      // identity would be gone the moment the orchestrator yielded its first
      // event, which is before any tool (and therefore any MCP call) runs. See
      // the warning on `turnContext.enter`.
      const iterator = turnContext.runGenerator(
        chatTurnContext(req, resolveScope(parsed.data)),
        () =>
          chat.chatStream(
            {
              userMessage: parsed.data.message,
              sessionScope: resolveScope(parsed.data),
              ...(userId ? { userId } : {}),
              ...webTurnOrigin(req),
              ...(deliveriesHint ? { conversationContextHint: deliveriesHint } : {}),
              ...(parsed.data.answerVerbosity
                ? { answerVerbosity: parsed.data.answerVerbosity }
                : {}),
            },
            observer,
          ),
      );
      // Keep draining the generator even after the client disconnects so the
      // orchestrator's 'done' path fires — that's where sessionLogger.log()
      // persists the turn. Otherwise a reload mid-stream loses the answer.
      // #1896 — a bare NO_REPLY ends as a silent `done`, never as text.
      for await (const event of suppressNoReplyStream(iterator)) {
        // Track activity + counters from the events the orchestrator yields
        // directly. The observer covers the streamed-from-Anthropic side;
        // these cover the tool-loop side.
        if (event.type === 'iteration_start') {
          currentIteration = event.iteration;
          toolCallsThisIter = 0;
          tokensStreamedThisIter = 0;
          lastActivityAt = Date.now();
        } else if (event.type === 'tool_use') {
          toolCallsThisIter += 1;
          phase = 'tool_running';
          lastActivityAt = Date.now();
          // #1017 item 4 — the `foreign` flag was dead: set by the CLI agent,
          // read by nobody. A foreign call means one of the CLI's own
          // built-ins ran despite the spawn gate, so it gets an error-level
          // log and a counter, not just a field on the wire.
          if (isForeignToolUse(event)) {
            foreignToolUseIds.add(event.id);
            recordForeignToolCall(event.name, effectiveSlug);
          }
          if (agentResolver) {
            const agent = agentResolver(event.name);
            if (agent) {
              safeWrite({ ...event, agent });
              continue;
            }
          }
        } else if (event.type === 'tool_result') {
          lastActivityAt = Date.now();
          if (foreignToolUseIds.has(event.id)) {
            safeWrite({ ...event, foreign: true });
            continue;
          }
        } else if (event.type === 'text_delta') {
          lastActivityAt = Date.now();
        }
        if (event.type === 'error') {
          streamError = event.message;
        }
        // #1094 — a DEGRADED `done` is a turn that threw; it is reported as
        // `done` only so the tool call it already committed is not written off
        // as failed (#506). Recording it as the operator's "last turn ok"
        // signal would be the same false green OM-100b removed below.
        if (event.type === 'done' && event.degraded === true) {
          // The cause rides the run trace; without it the status card shows a
          // bare "turn incomplete" where an error turn shows the provider text.
          const cause = event.runTrace?.error ? `: ${event.runTrace.error}` : '';
          streamError = `turn incomplete after ${event.committedTools?.join(', ') ?? 'a committed tool call'} (correlationId=${event.correlationId ?? 'unknown'})${cause}`;
        }
        safeWrite(event);
      }
      });
      // OM-100b: "the generator drained" is not the same as "the turn worked".
      // Both runtimes report a failed turn by yielding an `error` event and
      // then completing, so a bare drain would have recorded every dead turn
      // in the round-5 beta as a success — the exact false green this signal
      // exists to remove.
      if (streamError === undefined) {
        recordTurnSuccess();
      } else {
        recordTurnFailure(new Error(streamError));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[chat/stream] orchestrator failure:', err);
      const outcome = recordTurnFailure(err);
      if (!clientGone) {
        writeEvent(res, { type: 'error', code: outcome.errorCode, message });
      }
    } finally {
      clearInterval(heartbeatTimer);
      res.end();
    }
  });

  /**
   * Mid-turn steering — inject a user message into a turn that is currently
   * streaming. The orchestrator's iteration loop drains it at the next
   * iteration boundary and folds it into the conversation (see
   * `steeringBus`). Returns 202 when buffered for a live turn, or 409 when no
   * turn is in flight for the session (the caller should then send the message
   * as a normal new turn via `/chat/stream`).
   */
  router.post('/chat/steer', async (req: Request, res: Response) => {
    const parsed = SteerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        issues: parsed.error.issues,
      });
      return;
    }
    // #1762 — no steering of a turn in another account's chat.
    if (!parsed.data.scope && parsed.data.sessionId && !(await mayUseOwnChat(req, parsed.data.sessionId, options))) {
      res.status(404).json({ error: 'not_found', message: `chat session ${parsed.data.sessionId} not found` });
      return;
    }
    const sessionScope = resolveScope(parsed.data);
    const result = steeringBus.enqueue(sessionScope, parsed.data.message);
    if (!result.live) {
      res.status(409).json({
        error: 'no_active_turn',
        message:
          'no in-flight turn for this session — send the message as a new turn instead',
      });
      return;
    }
    res.status(202).json({ accepted: true, queued: result.queued });
  });

  return router;
}
