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

import { createHash, randomUUID } from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatStreamEvent, CoreApi, IncomingTurn } from '@omadia/channel-sdk';
import {
  AI_PROVENANCE_HEADER,
  AI_PROVENANCE_HEADER_VALUE,
  ENVELOPE_PROVENANCE,
} from '@omadia/channel-sdk';
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

/**
 * #647 — folds the AI-Act Art. 50 provenance marker into the `done` event as it
 * is forwarded, so a client can read the marking per TURN and not only per
 * connection (the header covers the connection).
 *
 * Only the `done` event is stamped; every other event passes through untouched,
 * so the NDJSON framing is unchanged and one JSON object still occupies one
 * line. Preserves a marker the base orchestrator might already carry (it does
 * not today, but #644 may) rather than overwriting it — this channel only fills
 * the gap. A turn that ends in-band with `{type:'error'}` never emits a `done`,
 * so on that path the marking is carried by the response header alone, which is
 * set at stream-open and is why that acceptance criterion holds.
 */
function withProvenance(event: ChatStreamEvent): ChatStreamEvent {
  if (event.type !== 'done') return event;
  return { ...event, provenance: event.provenance ?? ENVELOPE_PROVENANCE };
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
      // #647 — AI-Act Art. 50 provenance, connection level. Set BEFORE the
      // stream is flushed (and before any turn work runs), so it is present even
      // when the turn later ends in-band with `{type:'error'}` or throws
      // mid-turn: by then the 200 is already committed and the headers are gone.
      // The per-turn twin rides the `done` event via `withProvenance` below.
      res.setHeader(AI_PROVENANCE_HEADER, AI_PROVENANCE_HEADER_VALUE);
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
          // leakage. Hashing `key.keyId` (a per-key UUID, never
          // caller-controlled) together with the caller-supplied
          // conversationId — rather than plain string concatenation — makes
          // both that cross-key collision AND same-key collisions via lossy
          // downstream sanitization structurally impossible; see
          // `internalConversationId`'s doc comment for why concatenation
          // alone isn't enough.
          conversationId: internalConversationId(
            key.keyId,
            parsed.data.conversationId ?? randomUUID(),
          ),
          // Design decision (issue #438): the key IS its own identity — not a
          // delegate for a human end-user. No impersonation surface.
          //
          // Investigated (post-review): raw `key:<uuid>` is never resolved to
          // a knowledge-graph `omadiaUserId` before dispatch. Confirmed this
          // is NOT a plugin-specific regression — it matches the documented,
          // universal contract:
          //   - `ChannelUserRef.id` is typed "channel-native user id (opaque
          //     to core)" (harness-channel-sdk/src/incoming.ts) — no channel
          //     is expected to pre-resolve it.
          //   - `orchestratorDispatcher.ts` passes `input.userRef.id` straight
          //     through as `userId` with no resolution step, for every channel.
          //   - `resolveOrCreateChannelIdentity` is only ever called from the
          //     browser-login flow (src/index.ts, `/api/v1/auth`) to cache an
          //     `omadiaUserId` in the session JWT — it is not a per-turn,
          //     per-channel pattern. Even the one channel with that cached id
          //     available (omadia-ui-channel/canvasConnection.ts) uses the raw
          //     `session.subject`, not `session.omadiaUserId`, for `userRef.id`.
          //   - `src/routes/chat.ts`'s `resolveUserId()` already documents the
          //     same behaviour for Teams and generic HTTP callers: unresolved
          //     ids are "advisory metadata only" because
          //     `NeonKnowledgeGraph.ingestRun` throws when no matching
          //     User-Cluster node exists (by design — it never auto-creates
          //     one), so the run-trace ingest is dropped while the Session/Turn
          //     transcript still persists fine via `ingestTurn` (no such check).
          // Introducing per-key `resolveOrCreateChannelIdentity` resolution
          // here would be a NEW pattern no other channel implements, not an
          // alignment with an established one.
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
          safeWrite(withProvenance(event));
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
