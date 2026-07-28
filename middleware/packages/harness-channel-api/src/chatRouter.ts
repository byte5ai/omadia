/**
 * Issue #438 — POST /api/public/v1/chat.
 *
 * Public, self-authenticating chat ingress: verifies a per-key API key
 * (constant-time, see apiKeyToken.ts), applies that key's rate limit, records
 * one usage-audit entry, then drives the turn via `CoreApi.handleTurnStream`
 * — the SAME orchestrator dispatch every other channel uses, so PII masking
 * (privacy-guard), memory, and the knowledge graph all apply exactly as they
 * do for Teams/Telegram/Omadia UI. No second response-masking path here.
 *
 * NDJSON framing (one JSON event per line) mirrors `src/routes/chat.ts`'s
 * `/chat/stream` — this plugin cannot import that kernel route module
 * directly (plugins only depend on `@omadia/channel-sdk` / `@omadia/plugin-api`
 * / express), so the tiny `writeEvent` helper is duplicated rather than
 * imported.
 */

import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { CoreApi, IncomingTurn } from '@omadia/channel-sdk';

import type { ApiKeyStore } from './apiKeyStore.js';
import type { AuditLog } from './auditLog.js';
import type { RateLimiter } from './rateLimiter.js';

/** Relative to the router's mount prefix (`/api/public/v1`). */
export const CHAT_ROUTE = '/chat';

const ChatRequestSchema = z.object({
  message: z.string().min(1, 'message must be a non-empty string'),
  /** Caller-supplied thread id. Omitted → a fresh conversation per call. */
  conversationId: z.string().min(1).max(200).optional(),
});

/** NDJSON framing — see `src/routes/chat.ts`'s `writeEvent` (same shape). */
function writeEvent(res: Response, event: unknown): void {
  res.write(`${JSON.stringify(event)}\n`);
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return undefined;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

export interface ApiChatRouterDeps {
  /** Channel id this plugin registered under (== `ctx.agentId`). Scopes the
   *  orchestrator's conversation-id derivation, same as every other channel. */
  channelId: string;
  core: Pick<CoreApi, 'handleTurnStream'>;
  apiKeys: ApiKeyStore;
  rateLimiter: RateLimiter;
  auditLog: AuditLog;
}

export function createApiChatRouter(deps: ApiChatRouterDeps): Router {
  const router = Router();

  router.post(CHAT_ROUTE, async (req: Request, res: Response) => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'missing Authorization: Bearer <api-key> header',
      });
      return;
    }

    const key = await deps.apiKeys.verify(token);
    if (!key) {
      res.status(401).json({ error: 'unauthorized', message: 'invalid or revoked API key' });
      return;
    }

    if (!deps.rateLimiter.tryConsume(key.id, key.rateLimitPerMinute)) {
      res.status(429).json({
        error: 'rate_limited',
        message: `this key is limited to ${key.rateLimitPerMinute} requests/minute`,
      });
      return;
    }

    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }

    // Every AUTHENTICATED call is audited, before dispatch — a crash mid-turn
    // still leaves a record that the call happened. Fire-and-forget: a
    // logging failure must never block or fail the caller's chat turn.
    void deps.auditLog.record({
      keyId: key.id,
      route: CHAT_ROUTE,
      method: 'POST',
      at: Date.now(),
      status: 'ok',
    });

    // NDJSON streaming — see the doc comment at the top of this file.
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) clientGone = true;
    });
    const safeWrite = (event: unknown): void => {
      if (!clientGone) writeEvent(res, event);
    };

    try {
      const turn: IncomingTurn = {
        channelId: deps.channelId,
        conversationId: parsed.data.conversationId ?? randomUUID(),
        // Design decision (issue #438): the key IS its own identity — not a
        // delegate for a human end-user. No impersonation surface.
        userRef: {
          kind: 'custom',
          id: `key:${key.id}`,
          ...(key.label ? { displayName: key.label } : {}),
        },
        text: parsed.data.message,
      };
      for await (const event of deps.core.handleTurnStream(turn)) {
        safeWrite(event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!clientGone) writeEvent(res, { type: 'error', message });
    } finally {
      res.end();
    }
  });

  return router;
}
