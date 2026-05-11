import { Router } from 'express';

import type { NotesStore } from '../notesStore.js';

export interface HealthRouterOptions {
  readonly notes: NotesStore;
}

export function createHealthRouter(opts: HealthRouterOptions): Router {
  const router = Router();
  router.get('/health', async (_req, res) => {
    try {
      const list = await opts.notes.list();
      res.status(200).json({
        ok: true,
        agentId: '@omadia/agent-reference-maximum',
        notesCount: list.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  return router;
}
