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

import { createHash, randomUUID } from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { CoreApi, IncomingTurn } from '@omadia/channel-sdk';

import type { ApiKeyStore } from './apiKeyStore.js';
import type { AuditLog, AuditStatus } from './auditLog.js';
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

/**
 * True for an in-band `{type:'error', ...}` event forwarded from the
 * orchestrator stream. These complete the async iterator normally — nothing
 * throws — so the caller has to inspect the events themselves to notice the
 * turn failed (see the `sawInBandError` tracking below).
 */
function isErrorEvent(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    (event as { type: unknown }).type === 'error'
  );
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return undefined;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Derives the internal conversationId from the (fixed, never caller-
 * controlled) key id and the caller-supplied conversationId.
 *
 * This is NOT the same as namespacing via plain string concatenation
 * (`${keyId}:${callerConversationId}`), which was the original approach and
 * is unsafe: `CoreApi.handleTurnStream` folds this value into a scope string
 * that downstream `SessionLogger`'s `sanitizeScope` mangles — punctuation
 * runs (any char outside `[a-zA-Z0-9_-]`) collapse to a single `-`, the
 * result is lowercased, and it's truncated to 80 chars. Two distinct
 * caller-supplied ids can therefore land on the IDENTICAL sanitized scope
 * under the same key — e.g. `"case/a"` and `"case?a"` both sanitize to
 * `...-case-a`, and two long ids that only differ past the truncation cutoff
 * sanitize identically too. Either lets one conversation thread recall
 * another thread's memory/graph content under the same key.
 *
 * A fixed-width (64 hex chars, well under the 80-char cap), collision-
 * resistant hash of the same inputs sidesteps sanitizeScope's exact
 * transform rules entirely: hex digest output is already lowercase
 * alphanumeric, so nothing about it can be mangled or truncated into
 * colliding with a different digest.
 */
export function internalConversationId(keyId: string, callerConversationId: string): string {
  return createHash('sha256').update(`${keyId}:${callerConversationId}`).digest('hex');
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

    // From here on the caller is AUTHENTICATED (a valid, non-revoked key was
    // presented). Every code path below records exactly one audit entry with
    // the status that actually happened — rate-limited and invalid-request
    // rejections never dispatch, so they are audited immediately in place;
    // the dispatch path audits once, after the stream ends, reflecting
    // whether the handler threw. Fire-and-forget: a logging failure must
    // never block or fail the caller's chat turn.
    const audit = (status: AuditStatus): void => {
      void deps.auditLog.record({
        keyId: key.id,
        route: CHAT_ROUTE,
        method: 'POST',
        at: Date.now(),
        status,
      });
    };

    if (!deps.rateLimiter.tryConsume(key.id, key.rateLimitPerMinute)) {
      audit('rate_limited');
      res.status(429).json({
        error: 'rate_limited',
        message: `this key is limited to ${key.rateLimitPerMinute} requests/minute`,
      });
      return;
    }

    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      audit('invalid_request');
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }

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
        // Namespaced by key identity: CoreApi derives its scope as
        // `${channelId}::${conversationId}` (same channelId for every key
        // hitting this plugin), and same-scope recall does NOT check
        // userRef. An unnamespaced caller-supplied conversationId would let
        // two different API keys collide on the exact same core-side scope
        // by sending the same conversationId — cross-key context/transcript
        // leakage. Hashing `key.id` (a per-key UUID, never caller-controlled)
        // together with the caller-supplied conversationId — rather than
        // plain string concatenation — makes both that cross-key collision
        // AND same-key collisions via lossy downstream sanitization
        // structurally impossible; see `internalConversationId`'s doc
        // comment for why concatenation alone isn't enough.
        conversationId: internalConversationId(key.id, parsed.data.conversationId ?? randomUUID()),
        // Design decision (issue #438): the key IS its own identity — not a
        // delegate for a human end-user. No impersonation surface.
        userRef: {
          kind: 'custom',
          id: `key:${key.id}`,
          ...(key.label ? { displayName: key.label } : {}),
        },
        text: parsed.data.message,
      };
      // The orchestrator (or, with verifier mode on, the verifier wrapper)
      // can yield an in-band `{type:'error', ...}` event on this already-open
      // 200 stream WITHOUT throwing — the async iterator completes normally.
      // Track whether one was seen so we don't record 'ok' for a turn that
      // actually failed (same bug class as issue #403).
      let sawInBandError = false;
      for await (const event of deps.core.handleTurnStream(turn)) {
        if (isErrorEvent(event)) sawInBandError = true;
        safeWrite(event);
      }
      audit(sawInBandError ? 'error' : 'ok');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!clientGone) writeEvent(res, { type: 'error', message });
      audit('error');
    } finally {
      res.end();
    }
  });

  return router;
}
