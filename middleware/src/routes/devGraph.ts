import { Router } from 'express';
import type { Request, Response } from 'express';
import type { KnowledgeGraph } from '@omadia/plugin-api';

interface DevGraphDeps {
  graph: KnowledgeGraph;
}

/**
 * Unauthenticated, read-only endpoints the Next.js dev UI uses to render the
 * knowledge-graph tab. Mounted only behind DEV_ENDPOINTS_ENABLED. Never
 * reachable in production — callers of createDevGraphRouter must enforce the
 * flag themselves.
 */
export function createDevGraphRouter(deps: DevGraphDeps): Router {
  const router = Router();

  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      res.json(await deps.graph.stats());
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/sessions', async (req: Request, res: Response) => {
    const userIdParam = req.query['userId'];
    const userId =
      typeof userIdParam === 'string' && userIdParam.length > 0
        ? userIdParam
        : undefined;
    try {
      const sessions = await deps.graph.listSessions(
        userId ? { userId } : undefined,
      );
      res.json({
        sessions,
        ...(userId ? { filter: { userId } } : {}),
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/session/:scope', async (req: Request, res: Response) => {
    const scope = req.params['scope'];
    if (typeof scope !== 'string' || scope.length === 0) {
      res.status(400).json({ error: 'invalid_scope' });
      return;
    }
    try {
      const view = await deps.graph.getSession(scope);
      if (!view) {
        res.status(404).json({ error: 'not_found', scope });
        return;
      }
      res.json(view);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/run', async (req: Request, res: Response) => {
    const turnId = req.query['turnId'];
    if (typeof turnId !== 'string' || turnId.length === 0) {
      res.status(400).json({ error: 'turnId query param required' });
      return;
    }
    try {
      const view = await deps.graph.getRunForTurn(turnId);
      if (!view) {
        res.status(404).json({ error: 'not_found', turnId });
        return;
      }
      res.json(view);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/neighbors', async (req: Request, res: Response) => {
    const nodeId = req.query['nodeId'];
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      res.status(400).json({ error: 'nodeId query param required' });
      return;
    }
    try {
      const neighbors = await deps.graph.getNeighbors(nodeId);
      res.json({ nodeId, neighbors });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
