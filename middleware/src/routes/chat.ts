import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isNoReply, logNoReplyDrop } from '@omadia/channel-sdk';
import type { AskObserver, ChatAgent } from '@omadia/orchestrator';

import type { AgentResolver } from '../agents/resolveAgentForTool.js';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

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
});

function resolveScope(parsed: z.infer<typeof ChatRequestSchema>): string {
  if (parsed.scope) return `http-${parsed.scope}`;
  if (parsed.sessionId) return parsed.sessionId;
  return 'http-default';
}

const USER_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

/**
 * Pulls a user identity from the request. Dev/HTTP callers pass `x-user-id`;
 * Teams sets it from the AAD object id at its own router layer. Invalid or
 * oversize values are ignored (treated as anonymous) rather than throwing —
 * identity is advisory metadata, not an auth claim.
 */
function resolveUserId(req: Request): string | undefined {
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
}

export function createChatRouter(
  orchestrator: ChatAgent,
  options: CreateChatRouterOptions = {},
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

    try {
      const userId = resolveUserId(req);
      const sessionScope = resolveScope(parsed.data);
      const result = await orchestrator.chat({
        userMessage: parsed.data.message,
        sessionScope,
        ...(userId ? { userId } : {}),
      });
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
      const iterator = orchestrator.chatStream(
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

  return router;
}
