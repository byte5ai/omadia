import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isNoReply, logNoReplyDrop } from '@omadia/channel-sdk';
import { MAX_STEER_LENGTH, steeringBus } from '@omadia/orchestrator';
import type {
  AskObserver,
  ChatAgent,
  ChatSessionStore,
} from '@omadia/orchestrator';

import type { AgentResolver } from '../agents/resolveAgentForTool.js';

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
});

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
 * NDJSON framing: one JSON event per line. Easier to parse than SSE, works
 * with a plain fetch+ReadableStream on the browser side, and survives any
 * reverse proxy that handles chunked responses correctly.
 */
function writeEvent(res: Response, event: unknown): void {
  res.write(`${JSON.stringify(event)}\n`);
}

export interface CreateChatRouterOptions {
  /** Resolves tool names to installed-agent metadata so `tool_use` events
   *  carry agent pills for the UI. Optional — when absent (e.g. in tests),
   *  events are forwarded unchanged. */
  agentResolver?: AgentResolver;
  /** Phase A — per-Agent lookup. Returns the `ChatAgent` registered
   *  under `slug`, or `undefined` when the Agent is not active. */
  resolveChatAgent: (slug: string) => ChatAgent | undefined;
  /** Phase A — the no-pick default slug. Returns the platform fallback
   *  Agent's slug, or `undefined` when no fallback is configured. */
  getDefaultSlug: () => string | undefined;
  /** Phase A — chat session store, for snapshot capture on the first
   *  turn of a session. */
  chatSessionStore?: ChatSessionStore;
  /** Live resolver for the chat session store. Preferred over the static
   *  `chatSessionStore` so the store is picked up when the orchestrator
   *  plugin publishes it post-boot (Setup-Wizard key entry) without a
   *  restart. Falls back to `chatSessionStore` when absent. */
  getChatSessionStore?: () => ChatSessionStore | undefined;
  /** Phase A — builds a SessionConfigSnapshot for a given Agent slug.
   *  Same shape as `OrchestratorRegistry.snapshotForAgent`. */
  snapshotForAgent?: (slug: string) =>
    | {
        agentSlug: string;
        pluginIds: string[];
        toolIds: string[];
        memoryScope: string[];
        capturedAt: number;
      }
    | undefined;
}

/**
 * Phase A — per-request Agent resolution. Returns the effective slug +
 * ChatAgent, or sends an HTTP error and returns `undefined`. The caller
 * uses the returned slug to capture a snapshot on the first turn.
 */
async function resolveAgentForRequest(
  req: Request,
  res: Response,
  requestSlug: string | undefined,
  sessionId: string | undefined,
  options: CreateChatRouterOptions,
): Promise<{ chatAgent: ChatAgent; effectiveSlug: string } | undefined> {
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
  }

  const effectiveSlug = pinnedSlug ?? requestSlug ?? options.getDefaultSlug();
  if (!effectiveSlug) {
    res.status(412).json({
      error: 'no_fallback',
      message:
        'no agent slug provided and no platform fallback_agent_id is configured',
    });
    return undefined;
  }

  const chatAgent = options.resolveChatAgent(effectiveSlug);
  if (!chatAgent) {
    res.status(503).json({
      error: 'agent_unavailable',
      message: `agent "${effectiveSlug}" is not currently active`,
      slug: effectiveSlug,
    });
    return undefined;
  }
  return { chatAgent, effectiveSlug };
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
    );
    if (!resolved) return;
    const { chatAgent: chat, effectiveSlug } = resolved;

    try {
      const userId = resolveUserId(req);
      const sessionScope = resolveScope(parsed.data);
      const result = await chat.chat({
        userMessage: parsed.data.message,
        sessionScope,
        ...(userId ? { userId } : {}),
      });
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
        ...(result.privacyReceipt
          ? { privacyReceipt: result.privacyReceipt }
          : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[chat] orchestrator failure:', err);
      res.status(500).json({ error: 'orchestrator_failure', message });
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
    );
    if (!resolved) return;
    const { chatAgent: chat, effectiveSlug } = resolved;

    // NDJSON streaming. `X-Accel-Buffering: no` disables nginx response
    // buffering if the middleware ever sits behind one; harmless locally.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

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
      safeWrite({ type: 'agent_bound', slug: effectiveSlug });

      const iterator = chat.chatStream(
        {
          userMessage: parsed.data.message,
          sessionScope: resolveScope(parsed.data),
          ...(userId ? { userId } : {}),
        },
        observer,
      );
      // Keep draining the generator even after the client disconnects so the
      // orchestrator's 'done' path fires — that's where sessionLogger.log()
      // persists the turn. Otherwise a reload mid-stream loses the answer.
      for await (const event of iterator) {
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
          if (agentResolver) {
            const agent = agentResolver(event.name);
            if (agent) {
              safeWrite({ ...event, agent });
              continue;
            }
          }
        } else if (event.type === 'tool_result') {
          lastActivityAt = Date.now();
        } else if (event.type === 'text_delta') {
          lastActivityAt = Date.now();
        }
        safeWrite(event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[chat/stream] orchestrator failure:', err);
      if (!clientGone) {
        writeEvent(res, { type: 'error', message });
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
  router.post('/chat/steer', (req: Request, res: Response) => {
    const parsed = SteerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        issues: parsed.error.issues,
      });
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
