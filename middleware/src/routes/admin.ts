import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { MemoryStore } from '@omadia/plugin-api';

const PutBodySchema = z.object({
  path: z.string().min(1).startsWith('/memories'),
  content: z.string(),
  mode: z.enum(['create', 'overwrite']).default('overwrite'),
});

const DeleteBodySchema = z.object({
  path: z.string().min(1).startsWith('/memories'),
});

interface AdminDeps {
  store: MemoryStore;
  token: string;
}

/**
 * Admin endpoints for priming and inspecting memory from outside the orchestrator.
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>`. Mounted only when ADMIN_TOKEN is set.
 */
export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const supplied = header.slice('Bearer '.length).trim();
    if (!constantTimeEqual(supplied, deps.token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.put('/memory', async (req: Request, res: Response) => {
    const parsed = PutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const { path: virtualPath, content, mode } = parsed.data;
    try {
      if (mode === 'create') {
        await deps.store.createFile(virtualPath, content);
      } else {
        await deps.store.writeFile(virtualPath, content);
      }
      res.json({ ok: true, path: virtualPath, mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_write_failed', message });
    }
  });

  router.get('/memory/*path', async (req: Request, res: Response) => {
    const raw = req.params['path'];
    const segments = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const virtualPath = '/memories/' + segments.join('/');
    try {
      if (await deps.store.fileExists(virtualPath)) {
        const content = await deps.store.readFile(virtualPath);
        res.type('text/plain').send(content);
        return;
      }
      if (await deps.store.directoryExists(virtualPath)) {
        const entries = await deps.store.list(virtualPath);
        res.json({ path: virtualPath, entries });
        return;
      }
      res.status(404).json({ error: 'not_found', path: virtualPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_read_failed', message });
    }
  });

  router.delete('/memory', async (req: Request, res: Response) => {
    const parsed = DeleteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await deps.store.delete(parsed.data.path);
      res.json({ ok: true, path: parsed.data.path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_delete_failed', message });
    }
  });

  return router;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
