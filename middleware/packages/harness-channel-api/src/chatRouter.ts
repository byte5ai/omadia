/**
 * Issue #438 — POST /api/public/v1/chat.
 *
 * Public, self-authenticating chat ingress. Authentication, per-key rate
 * limiting and the usage-audit entry for rejected calls are all delegated to
 * `requireApiKey` from `@omadia/api-key-auth` (issue #439) — this route no
 * longer parses bearer headers or verifies hashes itself, so there is exactly
 * one API-key auth implementation in the codebase. The route requires the
 * `chat:write` scope, which every key (including every key minted before
 * scopes existed) carries by default.
 *
 * Past the guard, the turn is driven via `CoreApi.handleTurnStream` — the
 * SAME orchestrator dispatch every other channel uses, so PII masking
 * (privacy-guard), memory, and the knowledge graph all apply exactly as they
 * do for Teams/Telegram/Omadia UI. No second response-masking path here.
 *
 * NDJSON framing (one JSON event per line) mirrors `src/routes/chat.ts`'s
 * `/chat/stream` — this plugin cannot import that kernel route module
 * directly (plugins only depend on `@omadia/channel-sdk` / `@omadia/plugin-api`
 * / `@omadia/api-key-auth` / express), so the tiny `writeEvent` helper is
 * duplicated rather than imported.
 */

import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { CoreApi, IncomingTurn } from '@omadia/channel-sdk';
import type { ApiKeyStore, AuditLog, RateLimiter } from '@omadia/api-key-auth';
import { CHAT_WRITE_SCOPE, requireApiKey } from '@omadia/api-key-auth';

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

  router.post(
    CHAT_ROUTE,
    requireApiKey({
      apiKeys: deps.apiKeys,
      rateLimiter: deps.rateLimiter,
      auditLog: deps.auditLog,
      scope: CHAT_WRITE_SCOPE,
      // Pinned rather than derived from `req.path` so the audit trail keeps
      // reading `/chat` regardless of where the router gets mounted.
      routeLabel: CHAT_ROUTE,
    }),
    async (req: Request, res: Response) => {
      // `requireApiKey` never calls next() without setting this; the guard is
      // for the type, not for a reachable runtime state.
      const key = req.apiKey;
      if (!key) {
        res.status(401).json({ error: 'unauthorized', message: 'invalid or revoked API key' });
        return;
      }

      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        key.audit('invalid_request');
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
          // leakage. Prefixing with `key.keyId` (a per-key UUID, never
          // caller-controlled) makes that collision structurally impossible,
          // even when two different keys send identical conversationId values.
          conversationId: `${key.keyId}:${parsed.data.conversationId ?? randomUUID()}`,
          // Design decision (issue #438): the key IS its own identity — not a
          // delegate for a human end-user. No impersonation surface.
          userRef: {
            kind: 'custom',
            id: `key:${key.keyId}`,
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
        key.audit(sawInBandError ? 'error' : 'ok');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!clientGone) writeEvent(res, { type: 'error', message });
        key.audit('error');
      } finally {
        res.end();
      }
    },
  );

  return router;
}
