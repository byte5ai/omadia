import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatSession, ChatSessionStore } from '@omadia/orchestrator';
import {
  ChatSessionNotOwnedError,
  InvalidSessionIdError,
  ServerMirroredSessionError,
  chatSessionOwnedBy,
  isValidSessionId,
  isWebChatSessionId,
  scrubMcpInputEnvelopes as scrubStoredEnvelopes,
} from '@omadia/orchestrator';

import { recordOperatorAudit, type AdminAuditLog } from '../auth/adminAuditLog.js';
import { LLM_SETUP_HINT } from '../llmSetupHint.js';
import { chatViewer, type LegacyChatOwner } from './chatSessionAccess.js';
import { openChatDeliveryStream, type ChatDeliveryStreamDeps } from './chatDeliveryEvents.js';

/**
 * CRUD for persisted chat-tab sessions. Mounted at `/api/chat`, so the full
 * routes are:
 *
 *   GET    /api/chat/sessions            list summaries (newest first)
 *   GET    /api/chat/sessions/:id        full session document (incl. the
 *                                        server-owned `resetAt`, #1071)
 *   PUT    /api/chat/sessions/:id        upsert — body must match id. MERGES
 *                                        (#1071): keeps server-written
 *                                        proactive messages the body lacks and
 *                                        answers `{ ok, session }` with the
 *                                        stored document. An empty `messages`
 *                                        array is NOT a clear.
 *   GET    /api/chat/sessions/:id/events  SSE: a signal per routine delivery
 *                                        into this chat (#2354, ADR-0321)
 *   DELETE /api/chat/sessions/:id        drop the file
 *   POST   /api/chat/sessions/:id/reset  the explicit clear: drops turns AND
 *                                        routine deliveries, stamps `resetAt`
 *   POST   /api/chat/sessions/:id/re-snapshot  drop the pinned Agent snapshot
 *
 * Gated by `requireAuth` at mount time (see middleware/src/index.ts) —
 * Sessions können PII / Tool-Outputs / Code-Snippets enthalten.
 *
 * #1762 (ADR-0180): a chat belongs to the account that created it. Every
 * route lists or touches only the caller's own chats; another account's chat
 * answers 404 like a missing one. The owner is stamped by the server.
 */

const IdParam = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

const SubAgentEventSchema = z.object({
  kind: z.enum(['iteration', 'tool_use', 'tool_result']),
  at: z.number(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  output: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  isError: z.boolean().optional(),
  iteration: z.number().int().nonnegative().optional(),
});

const ToolEventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
  output: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  isError: z.boolean().optional(),
  startedAt: z.number().optional(),
  liveElapsedMs: z.number().nonnegative().optional(),
  subEvents: z.array(SubAgentEventSchema).optional(),
});

// The answer verifier's summary of a turn (`VerifierResultSummary`). Mirrored
// so a session resumed from the server shows the verdict and the withheld-
// answer marker, not only after a local reload. A summary that does not fit is
// dropped on its own (`.catch`) instead of failing the whole session write —
// it is client-held state, and the web chat re-checks every summary it renders.
const count = z.number().int().nonnegative();
const VerifierSummarySchema = z.object({
  badge: z.enum(['verified', 'partial', 'corrected', 'failed', 'unverified', 'unavailable']),
  status: z.enum(['approved', 'approved_with_disclaimer', 'blocked', 'skipped', 'unavailable']),
  reason: z
    .enum([
      'no_trigger',
      'no_claims',
      'no_checkable_claims',
      'incomplete_coverage',
      'system_data',
      'extractor_error',
      'pipeline_error',
      'privacy_shield',
    ])
    .optional(),
  claimCount: count,
  contradictionCount: count,
  unverifiedCount: count,
  uncheckedCount: count.optional(),
  uncoveredCount: count.optional(),
  retryCount: count,
  latencyMs: z.number().nonnegative(),
  mode: z.enum(['shadow', 'enforce']),
});

const MessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  tools: z.array(ToolEventSchema).optional(),
  telemetry: z
    .object({
      tool_calls: z.number().int().nonnegative(),
      iterations: z.number().int().nonnegative(),
    })
    .optional(),
  error: z.boolean().optional(),
  // #1896 — a deliberate NO_REPLY turn; the chat shows no bubble for it.
  silent: z.literal(true).optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  // #1071 — marker of a server-written routine delivery. Accepted so a
  // client round-trip does not strip it (zod strips unknown keys); the store
  // trusts it only when the server's own copy carries it.
  proactive: z
    .object({
      deliveredAt: z.number(),
      routineId: z.string().optional(),
      routineName: z.string().max(200).optional(),
      droppedAttachments: z.number().int().nonnegative().optional(),
      droppedInteractive: z.string().max(100).optional(),
    })
    .optional(),

  // #2045 — who the message is from (agent or `system`), stamped by the
  // harness; kept so a reloaded chat still shows the speaker per message. A
  // malformed value is dropped, never trusted for anything but display.
  speaker: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('agent'),
        agentId: z.string().min(1).max(100),
        slug: z.string().min(1).max(100),
        displayName: z.string().min(1).max(200),
        // Only the kernel's own same-origin avatar path: the client stores
        // this, so it must not become a way to show any URL as an avatar.
        avatarUrl: z
          .string()
          .max(500)
          .regex(/^\/api\/v1\/operator\/agents\/[A-Za-z0-9_-]+\/identity\/avatar(?:\?v=[A-Za-z0-9._~%-]*)?$/)
          .optional(),
      }),
      z.object({ kind: z.literal('system') }),
    ])
    .optional()
    .catch(undefined),
  systemNotice: z
    .object({ code: z.string().min(1).max(64), text: z.string().max(2000) })
    .optional()
    .catch(undefined),
  verifier: VerifierSummarySchema.optional().catch(undefined),
  // The answer verifier withheld this turn's answer (`enforce` mode); the
  // content is the notice saying so.
  verifierBlocked: z.literal(true).optional().catch(undefined),
  // Privacy Shield v4 rendered the answer from the source system's data.
  systemData: z.literal(true).optional().catch(undefined),
  // The decision model's verdict (fast path, e.g. TypeSafe Jev) — kept so
  // the chat badge survives a reload; a malformed value is dropped.
  fastPathDecision: z
    .object({
      provider: z.string().min(1).max(80),
      model: z.string().max(80).optional(),
      verdict: z.enum(['data', 'model']),
      route: z.enum(['simple', 'complex']).optional(),
      tool: z.string().max(80).optional(),
      confidence: z.number().min(0).max(1),
      ms: z.number().nonnegative(),
      direct: z.literal(true).optional(),
      answered: z.literal(true).optional(),
      fallback: z.literal(true).optional(),
      steps: z
        .array(
          z.object({
            task: z.string().min(1).max(80),
            choice: z.string().min(1).max(120),
            confidence: z.number().min(0).max(1),
            ms: z.number().nonnegative(),
          }),
        )
        .max(8)
        .optional(),
      ui: z
        .object({
          skeleton: z.enum(['plan', 'cache', 'simple', 'composer']),
          layout: z.enum(['table', 'bar', 'line', 'pie']).optional(),
        })
        .optional(),
    })
    .optional()
    .catch(undefined),
});

const SessionSchema = z.object({
  id: IdParam,
  title: z.string().min(1).max(200),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(MessageSchema),
});

type ClientSession = z.infer<typeof SessionSchema>;

/** #1953 — shared with the store's one-time sweep (#2311). */
export function scrubMcpInputEnvelopes(session: ClientSession): ClientSession {
  return scrubStoredEnvelopes(session);
}

interface ChatSessionDeps {
  /** Live resolver for the chat session store. Returns `undefined` while the
   *  orchestrator plugin has not published it yet (no ANTHROPIC_API_KEY) — the
   *  handlers then 503 instead of the kernel hard-failing at boot. Set via the
   *  key save on the LLM access page reactivates the plugin and makes this
   *  resolve non-null. */
  getStore: () => ChatSessionStore | undefined;
  /** #1762 — owner of chats written before owners existed; see `chatSessionAccess.ts`. */
  legacyOwner?: LegacyChatOwner;
  /**
   * ADR-0187 (#1986) — drop the caller's records of generated files made in
   * this chat; files no other chat or person references are deleted. Runs
   * after the transcript is gone; a failure is logged, never fails the delete.
   */
  releaseGenerated?: (scope: string, ownerOmadiaUserId: string | undefined) => Promise<unknown>;
  /** #1753 — remove the markdown transcripts of the chat's scope when it is deleted. */
  purgeTranscripts?: (sessionScope: string) => Promise<void>;
  /** #1757 — the routines that deliver into a chat; absent = no routines feature. */
  routines?: () => ChatRoutinesPort | undefined;
  /**
   * #2318 (ADR-0100) — the admin audit trail. Deleting an existing chat writes
   * a `chat.delete` row after the fact (best-effort and loud: a failed write is
   * logged, the delete stands). Absent = no row.
   */
  audit?: () => Pick<AdminAuditLog, 'record'> | undefined;
  /**
   * #2354 (ADR-0321) — live delivery signals for an open chat. Absent = the
   * events route answers 404 and the web UI keeps its poll.
   */
  deliveries?: ChatDeliveryStreamDeps;
}

/** #1757 — what the chat routes need of the routines feature. */
export interface ChatRoutinesPort {
  listForChat(sessionId: string): Promise<ReadonlyArray<{ id: string; name: string }>>;
  /** Pauses the chat's active routines; resolves to the ids it paused. */
  pauseForChat(sessionId: string): Promise<ReadonlyArray<string>>;
}

export function createChatSessionsRouter(deps: ChatSessionDeps): Router {
  const router = Router();
  const { getStore } = deps;
  const legacyOwner = async (): Promise<string | undefined> => deps.legacyOwner?.();

  /** The caller's own chat `id`, or `null` when it is missing or another account's. */
  const ownSession = async (
    store: ChatSessionStore,
    req: Request,
    id: string,
  ): Promise<ChatSession | null> => {
    let session: ChatSession | null;
    try {
      session = await store.get(id);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // An unreadable chat has no readable owner: it is a legacy chat, and
      // only its resolved owner may delete or reset it.
      const owned = chatSessionOwnedBy({}, chatViewer(req), await legacyOwner());
      return owned ? ({ id, title: id, createdAt: 0, updatedAt: 0, messages: [] } satisfies ChatSession) : null;
    }
    if (!session) return null;
    return chatSessionOwnedBy(session, chatViewer(req), await legacyOwner()) ? session : null;
  };

  /** Resolve the store or emit a 503; handlers `return` when it's undefined. */
  const resolveStore = (res: Response): ChatSessionStore | undefined => {
    const store = getStore();
    if (!store) {
      res.status(503).json({
        error: 'chat_unavailable',
        message:
          `chat is not configured — ${LLM_SETUP_HINT}`,
      });
      return undefined;
    }
    return store;
  };

  /**
   * #2318 (ADR-0100) — one `chat.delete` row per deleted chat, with what the
   * delete took along. Ids and counts only, never chat content.
   */
  const auditChatDelete = (
    req: Request,
    id: string,
    after: { kind: 'web' | 'other'; routinesPaused: ReadonlyArray<string>; transcriptsPurged: boolean },
  ): Promise<void> =>
    recordOperatorAudit(deps.audit?.(), req, {
      action: 'chat.delete',
      target: `chat:${id}`,
      after: {
        kind: after.kind,
        transcriptsPurged: after.transcriptsPurged,
        routinesPaused: after.routinesPaused.map((routineId) => `routine:${routineId}`),
      },
    });

  router.get('/sessions', async (req: Request, res: Response) => {
    const store = resolveStore(res);
    if (!store) return;
    try {
      const sessions = await store.list({ viewer: chatViewer(req), legacyOwner: await legacyOwner() });
      res.json({ sessions });
    } catch (err) {
      failure(res, err, '[chat-sessions] list');
    }
  });

  router.get('/sessions/:id', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !isValidSessionId(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const store = resolveStore(res);
    if (!store) return;
    try {
      const session = await ownSession(store, req, id);
      if (!session) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // The owner id is not the caller's business beyond "it is yours".
      const { ownerUserId: _owner, ...body } = session;
      res.json(body);
    } catch (err) {
      failure(res, err, '[chat-sessions] get');
    }
  });

  router.get('/sessions/:id/events', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !isValidSessionId(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    if (!deps.deliveries) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const store = resolveStore(res);
    if (!store) return;
    try {
      // Only the chat's owner learns when something lands in it.
      if (!(await ownSession(store, req, id))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
    } catch (err) {
      failure(res, err, '[chat-sessions] events');
      return;
    }
    openChatDeliveryStream(req, res, id, deps.deliveries);
  });

  router.put('/sessions/:id', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !isValidSessionId(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const parsed = SessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
      return;
    }
    if (parsed.data.id !== id) {
      res.status(400).json({ error: 'id_mismatch' });
      return;
    }
    const store = resolveStore(res);
    if (!store) return;
    const viewer = chatViewer(req);
    if (!viewer) {
      res.status(401).json({ error: 'no_account', message: 'a chat is saved under the signed-in account' });
      return;
    }
    try {
      // #1071 — merge, not overwrite: the client PUTs the whole document from
      // a copy hydrated at page load, which would otherwise delete a routine
      // delivery the server appended since.
      const stored = await store.saveFromClient(scrubMcpInputEnvelopes(parsed.data), {
        viewer,
        legacyOwner: await legacyOwner(),
      });
      const { ownerUserId: _owner, ...session } = stored;
      res.json({ ok: true, session });
    } catch (err) {
      if (err instanceof InvalidSessionIdError) {
        res.status(400).json({ error: 'invalid_id' });
        return;
      }
      if (err instanceof ChatSessionNotOwnedError) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // A browser pushing back a purged server-mirrored transcript (canvas /
      // routine turns that were never a web chat) — refused, not re-created.
      if (err instanceof ServerMirroredSessionError) {
        res.status(409).json({ error: 'server_mirrored_session' });
        return;
      }
      failure(res, err, '[chat-sessions] save');
    }
  });

  router.delete('/sessions/:id', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !isValidSessionId(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const store = resolveStore(res);
    if (!store) return;
    try {
      // Idempotent for a missing chat; another account's answers 404.
      const exists = await store.fileExistsFor(id);
      if (exists && !(await ownSession(store, req, id))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // #1753 / #1757 — only a saved web chat takes its transcripts and
      // routines with it: an unsaved id, or one of another scope (a routine,
      // a Teams conversation, a shared bucket), may name someone else's.
      const existed = exists && isWebChatSessionId(id);
      await store.delete(id);
      // ADR-0187 (#1986) — the caller's records of generated files made in this
      // chat; only their own rows, so it is safe for a chat that never existed.
      // A failure is logged and never fails the delete.
      await deps.releaseGenerated?.(id, req.session?.omadia_user_id).catch((err: unknown) => {
        console.error('[chat-sessions] generated files not released:', err instanceof Error ? err.message : err);
      });
      if (!existed) {
        // #2318 — a stored chat of another shape (no transcripts, no routines)
        // is still a deletion of the caller's data; a missing id deleted nothing.
        if (exists) await auditChatDelete(req, id, { kind: 'other', routinesPaused: [], transcriptsPurged: false });
        res.json({ ok: true, routinesPaused: 0 });
        return;
      }
      // #1753 — the chat's transcripts (`/memories/sessions/<id>/`) go with it:
      // the orchestrator is told to look there for earlier conversations.
      let transcriptsPurged = false;
      if (deps.purgeTranscripts) {
        await deps.purgeTranscripts(id).then(
          () => {
            transcriptsPurged = true;
          },
          (err: unknown) => {
            console.error(`[chat-sessions] removing the transcripts of chat ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
          },
        );
      }
      // #1757 — routines that delivered into this chat are paused now, with
      // the reason, instead of each failing its next run first.
      let pausedIds: ReadonlyArray<string> = [];
      try {
        pausedIds = (await deps.routines?.()?.pauseForChat(id)) ?? [];
      } catch (err) {
        console.error(`[chat-sessions] pausing the routines of chat ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await auditChatDelete(req, id, { kind: 'web', routinesPaused: pausedIds, transcriptsPurged });
      const routinesPaused = pausedIds.length;
      res.json({ ok: true, routinesPaused });
    } catch (err) {
      failure(res, err, '[chat-sessions] delete');
    }
  });

  /** #1757 — the active routines that deliver into a chat, named in the close confirmation. */
  router.get('/sessions/:id/routines', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !isValidSessionId(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const store = resolveStore(res);
    if (!store) return;
    try {
      // Only the chat's owner learns which routines deliver into it.
      if (!(await store.fileExistsFor(id))) {
        res.json({ routines: [] });
        return;
      }
      if (!(await ownSession(store, req, id))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const routines = (await deps.routines?.()?.listForChat(id)) ?? [];
      res.json({ routines: routines.map((r) => ({ id: r.id, name: r.name })) });
    } catch (err) {
      failure(res, err, '[chat-sessions] routines');
    }
  });

  /**
   * Reset a session: drop messages, keep id/title, return a fresh
   * conversation-id so the client (and a future audit log) can correlate
   * the boundary. Memory and Knowledge-Graph entries are NOT touched —
   * a reset only wipes the agent's working context window.
   */
  router.post('/sessions/:id/reset', async (req: Request, res: Response) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !isValidSessionId(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const store = resolveStore(res);
    if (!store) return;
    try {
      if (!(await ownSession(store, req, id))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const updated = await store.resetMessages(id);
      if (!updated) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({
        sessionId: updated.id,
        newConversationId: `${updated.id}:${String(updated.updatedAt)}`,
        resetAt: updated.updatedAt,
      });
    } catch (err) {
      if (err instanceof InvalidSessionIdError) {
        res.status(400).json({ error: 'invalid_id' });
        return;
      }
      failure(res, err, '[chat-sessions] reset');
    }
  });

  /**
   * Phase A / TA08 — clear the session's pinned Agent snapshot. Next
   * turn re-captures from the current registry state (typically the
   * fallback). Idempotent; no-op when the session has no snapshot.
   */
  router.post(
    '/sessions/:id/re-snapshot',
    async (req: Request, res: Response) => {
      const id = req.params['id'];
      if (typeof id !== 'string' || !isValidSessionId(id)) {
        res.status(400).json({ error: 'invalid_id' });
        return;
      }
      const store = resolveStore(res);
      if (!store) return;
      try {
        const existing = await ownSession(store, req, id);
        if (!existing) {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        await store.clearSnapshot(id);
        res.json({ ok: true, sessionId: id });
      } catch (err) {
        if (err instanceof InvalidSessionIdError) {
          res.status(400).json({ error: 'invalid_id' });
          return;
        }
        failure(res, err, '[chat-sessions] re-snapshot');
      }
    },
  );

  return router;
}

function failure(res: Response, err: unknown, logPrefix: string): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${logPrefix} failure:`, err);
  res.status(500).json({ error: 'internal_error', message });
}
