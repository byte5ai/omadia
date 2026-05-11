import { Router } from 'express';
import type { Request, Response } from 'express';
import type { MemoryStore } from '@omadia/plugin-api';

interface DevMemoryDeps {
  store: MemoryStore;
}

/**
 * Unauthenticated, read-only memory browser for the local Next.js dev UI.
 * Mounted only when the plugin's `dev_memory_endpoints_enabled` config flag
 * resolves truthy — the kernel enforces that the setting is never set in
 * production. Never expose this in production; the whole `/memories` tree
 * is readable without credentials.
 *
 * Endpoints:
 * - GET /list?path=/memories[/...]  → directory listing up to 2 levels deep
 * - GET /file?path=/memories/...    → file content (text/plain)
 */
export function createDevMemoryRouter(deps: DevMemoryDeps): Router {
  const router = Router();

  router.get('/list', async (req: Request, res: Response) => {
    const virtualPath = normalisePath(req.query['path']);
    if (virtualPath === undefined) {
      res.status(400).json({ error: 'invalid_path' });
      return;
    }
    try {
      if (!(await deps.store.directoryExists(virtualPath))) {
        res.status(404).json({ error: 'not_found', path: virtualPath });
        return;
      }
      const entries = await deps.store.list(virtualPath);
      res.json({ path: virtualPath, entries });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_list_failed', message });
    }
  });

  router.get('/file', async (req: Request, res: Response) => {
    const virtualPath = normalisePath(req.query['path']);
    if (virtualPath === undefined) {
      res.status(400).json({ error: 'invalid_path' });
      return;
    }
    try {
      if (!(await deps.store.fileExists(virtualPath))) {
        res.status(404).json({ error: 'not_found', path: virtualPath });
        return;
      }
      const content = await deps.store.readFile(virtualPath);
      res.type('text/plain; charset=utf-8').send(content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'memory_read_failed', message });
    }
  });

  return router;
}

function normalisePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return '/memories';
  if (!raw.startsWith('/memories')) return undefined;
  return raw;
}
