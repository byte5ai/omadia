import { Router } from 'express';
import type { Request, Response } from 'express';
import type { GraphNode, KnowledgeGraph } from '@omadia/plugin-api';

import { PlanScopeCache } from './planScopeCache.js';

/** Cached `/plans` payload shape: a scope's plans, each with its steps. */
export type PlanWithSteps = { plan: GraphNode; steps: GraphNode[] };

interface DevGraphDeps {
  graph: KnowledgeGraph;
  /** Optional injected cache (tests pass a clock-controlled instance). When
   *  omitted, a default short-TTL cache is created per router. */
  planCache?: PlanScopeCache<PlanWithSteps[]>;
}

/**
 * Unauthenticated, read-only endpoints the Next.js dev UI uses to render the
 * knowledge-graph tab. Mounted only behind DEV_ENDPOINTS_ENABLED. Never
 * reachable in production — callers of createDevGraphRouter must enforce the
 * flag themselves.
 */
export function createDevGraphRouter(deps: DevGraphDeps): Router {
  const router = Router();
  const planCache = deps.planCache ?? new PlanScopeCache<PlanWithSteps[]>();

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

  // Memory Focused View — every MemorableKnowledge (+ its PalaiaExcerpts)
  // with 2-hop provenance ancestors pre-resolved. Pass `?scope=__ALL__` (or
  // omit the param) to walk every session; pass a concrete session scope
  // to filter MKs to those `DERIVED_FROM` a Turn of that scope. ACL is NOT
  // enforced; the gating happens at the DEV_ENDPOINTS_ENABLED level.
  router.get('/memories', async (req: Request, res: Response) => {
    const scopeParam = req.query['scope'];
    const limitParam = req.query['limit'];
    const includeExcerptsParam = req.query['includeExcerpts'];
    const scope =
      typeof scopeParam === 'string' &&
      scopeParam.length > 0 &&
      scopeParam !== '__ALL__'
        ? scopeParam
        : undefined;
    const limit =
      typeof limitParam === 'string' && limitParam.length > 0
        ? Number.parseInt(limitParam, 10)
        : undefined;
    const includeExcerpts =
      typeof includeExcerptsParam === 'string'
        ? includeExcerptsParam !== 'false' && includeExcerptsParam !== '0'
        : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      res.status(400).json({ error: 'invalid_limit' });
      return;
    }
    try {
      const view = await deps.graph.listMemoriesForScope(scope, {
        ...(limit !== undefined ? { limit } : {}),
        ...(includeExcerpts !== undefined ? { includeExcerpts } : {}),
      });
      res.json({
        ...(scope ? { scope } : { scope: '__ALL__' }),
        ...view,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Slice 11.5 — Topic overlay. Returns `topics` (every Topic node in
  // the tenant) + `edges` (every HAS_TOPIC edge as external-id pair).
  // Dev-only; ACL bypass behind DEV_ENDPOINTS_ENABLED.
  router.get('/topics', async (_req: Request, res: Response) => {
    try {
      const [topics, edges] = await Promise.all([
        deps.graph.listTopics(),
        deps.graph.listTopicMembershipEdges(),
      ]);
      res.json({ topics, edges });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Slice 11.5 — Issue overlay. Returns every Inconsistency +
  // MergeCandidate + their MK-side edges as external-id pairs. Pass
  // `?status=open|resolved|dismissed` to filter; omit for all.
  router.get('/issues', async (req: Request, res: Response) => {
    const statusParam = req.query['status'];
    const status =
      typeof statusParam === 'string' &&
      (statusParam === 'open' ||
        statusParam === 'resolved' ||
        statusParam === 'dismissed')
        ? statusParam
        : undefined;
    try {
      const view = await deps.graph.listAllIssues(
        status ? { status } : undefined,
      );
      res.json({ ...view, ...(status ? { status } : {}) });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // #133 (E7) — Plan overlay. Returns every Plan node for a scope plus its
  // ordered PlanSteps (status + dependsOn live in `props`) so the graph view
  // can render the per-turn plan DAG. Plan nodes are otherwise orphans in the
  // graph (the PLAN_OF→Turn edge is skipped — onBeforeTurn precedes Turn
  // persistence), so this scope-keyed lookup is the only way to surface them.
  router.get('/plans', async (req: Request, res: Response) => {
    const scopeParam = req.query['scope'];
    if (typeof scopeParam !== 'string' || scopeParam.length === 0) {
      res.status(400).json({ error: 'scope query param required' });
      return;
    }
    try {
      const cached = planCache.get(scopeParam);
      if (cached) {
        res.json({ scope: scopeParam, plans: cached });
        return;
      }
      const planNodes = await deps.graph.listPlansForScope(scopeParam);
      // One batched read for all steps instead of a getPlanSteps per plan
      // (the old Promise.all fanned out 1+2N Neon round-trips per request).
      const stepsByPlan = await deps.graph.getPlanStepsForPlans(
        planNodes.map((p) => p.id),
      );
      const plans: PlanWithSteps[] = planNodes.map((plan) => ({
        plan,
        steps: stepsByPlan.get(plan.id) ?? [],
      }));
      planCache.set(scopeParam, plans);
      res.json({ scope: scopeParam, plans });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
