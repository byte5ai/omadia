import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChatSessionStore} from '@omadia/orchestrator';
import {
  InvalidSessionIdError,
  isValidSessionId,
} from '@omadia/orchestrator';

/**
 * CRUD for persisted chat-tab sessions. Mounted at `/api/chat`, so the full
 * routes are:
 *
 *   GET    /api/chat/sessions            list summaries (newest first)
 *   GET    /api/chat/sessions/:id        full session document
 *   PUT    /api/chat/sessions/:id        upsert — body must match id
 *   DELETE /api/chat/sessions/:id        drop the file
 *
 * Gated by `requireAuth` at mount time (see middleware/src/index.ts) —
 * Sessions können PII / Tool-Outputs / Code-Snippets enthalten.
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
  startedAt: z.number(),
  finishedAt: z.number().optional(),
});

const SessionSchema = z.object({
  id: IdParam,
  title: z.string().min(1).max(200),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(MessageSchema),
});

interface ChatSessionDeps {
  store: ChatSessionStore;
}

export function createChatSessionsRouter(deps: ChatSessionDeps): Router {
  const router = Router();
  const { store } = deps;

  router.get('/sessions', async (_req: Request, res: Response) => {
    try {
      const sessions = await store.list();
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
    try {
      const session = await store.get(id);
      if (!session) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(session);
    } catch (err) {
      failure(res, err, '[chat-sessions] get');
    }
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
    try {
      await store.save(parsed.data);
      res.json({ ok: true, session: parsed.data });
    } catch (err) {
      if (err instanceof InvalidSessionIdError) {
        res.status(400).json({ error: 'invalid_id' });
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
    try {
      await store.delete(id);
      res.json({ ok: true });
    } catch (err) {
      failure(res, err, '[chat-sessions] delete');
    }
  });

  return router;
}

function failure(res: Response, err: unknown, logPrefix: string): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${logPrefix} failure:`, err);
  res.status(500).json({ error: 'internal_error', message });
}
