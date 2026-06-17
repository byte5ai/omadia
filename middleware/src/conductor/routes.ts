import { Router } from 'express';
import type { Request, Response } from 'express';

import { validate } from '@omadia/conductor-core';
import type { JsonObject, WorkflowGraph } from '@omadia/conductor-core';

import type { ConductorWorkflowStore } from './workflowStore.js';
import type { ConductorRunStore } from './runStore.js';
import type { ConductorAwaitStore } from './awaitStore.js';
import type { ConductorEventRouter } from './eventRouter.js';
import {
  AwaitNotPendingError,
  ConductorRunExecutor,
  WorkflowDisabledError,
  WorkflowNotFoundError,
  WorkflowNotPublishedError,
} from './runExecutor.js';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asObject(v: unknown): JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : {};
}

function paramStr(v: string | string[] | undefined): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0] ?? '';
  return '';
}

export interface ConductorRouterDeps {
  workflowStore: ConductorWorkflowStore;
  runStore: ConductorRunStore;
  awaitStore: ConductorAwaitStore;
  executor: ConductorRunExecutor;
  eventRouter: ConductorEventRouter;
}

/**
 * Operator-facing Conductor API, mounted behind requireAuth at
 * /api/v1/operator/conductors. Lets an operator publish a workflow (graph
 * validated by @omadia/conductor-core before persist), start manual runs, and
 * read the durable run trace.
 */
export function createConductorRouter(deps: ConductorRouterDeps): Router {
  const router = Router();

  // List workflows.
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json({ workflows: await deps.workflowStore.list() });
    } catch (err) {
      res.status(500).json({ code: 'conductor.list_failed', message: errMsg(err) });
    }
  });

  // Create or publish a workflow version. Validates the graph first.
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const slug = typeof body.slug === 'string' ? body.slug : '';
    const name = typeof body.name === 'string' ? body.name : '';
    if (!slug || !name) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'slug and name are required' });
      return;
    }
    const graph = body.graph as unknown as WorkflowGraph;
    const result = validate(graph);
    if (!result.ok) {
      res.status(400).json({ code: 'conductor.invalid_graph', errors: result.errors });
      return;
    }
    try {
      const out = await deps.workflowStore.createOrPublish({
        slug,
        name,
        description: typeof body.description === 'string' ? body.description : null,
        graph,
        enable: body.enable === true,
      });
      res.status(201).json({
        workflow: out.workflow,
        version: { id: out.version.id, version: out.version.version },
      });
    } catch (err) {
      console.error('[conductor] publish failed:', err);
      res.status(500).json({ code: 'conductor.publish_failed', message: errMsg(err) });
    }
  });

  // Emit a domain event — starts a run for every workflow with a matching event trigger (US4).
  // The kernel-side seam a connector calls; exposed here so the operator can fire/test events.
  router.post('/emit', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const eventId = typeof body.eventId === 'string' ? body.eventId : '';
    if (!eventId) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'eventId is required' });
      return;
    }
    try {
      const result = await deps.eventRouter.emit(eventId, asObject(body.payload));
      res.status(202).json(result);
    } catch (err) {
      console.error('[conductor] emit failed:', err);
      res.status(500).json({ code: 'conductor.emit_failed', message: errMsg(err) });
    }
  });

  // Operator inbox — all pending human awaits across runs.
  router.get('/awaits/pending', async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json({ awaits: await deps.awaitStore.listWaiting() });
    } catch (err) {
      res.status(500).json({ code: 'conductor.awaits_failed', message: errMsg(err) });
    }
  });

  // Answer a pending human await — records the response, resolves the await, resumes the run.
  router.post('/awaits/:awaitId/respond', async (req: Request, res: Response): Promise<void> => {
    const awaitId = paramStr(req.params.awaitId);
    const responder = req.session?.sub ?? 'operator';
    const response = asObject(req.body).response ?? asObject(req.body);
    try {
      const run = await deps.executor.resolveAwait(awaitId, responder, response);
      res.json({ run });
    } catch (err) {
      if (err instanceof AwaitNotPendingError) {
        res.status(409).json({ code: 'conductor.await_not_pending', message: err.message });
      } else {
        console.error('[conductor] respond failed:', err);
        res.status(500).json({ code: 'conductor.respond_failed', message: errMsg(err) });
      }
    }
  });

  // Fetch a workflow + its active version graph (for the visual editor to load).
  router.get('/:slug', async (req: Request, res: Response): Promise<void> => {
    try {
      const wf = await deps.workflowStore.getBySlug(paramStr(req.params.slug));
      if (!wf || !wf.activeVersionId) {
        res.status(404).json({ code: 'conductor.not_found', message: 'workflow or active version missing' });
        return;
      }
      const version = await deps.workflowStore.getVersion(wf.activeVersionId);
      res.json({ workflow: wf, graph: version?.graph ?? null });
    } catch (err) {
      res.status(500).json({ code: 'conductor.get_failed', message: errMsg(err) });
    }
  });

  // Enable / disable a workflow.
  router.post('/:slug/status', async (req: Request, res: Response): Promise<void> => {
    const status = asObject(req.body).status;
    if (status !== 'enabled' && status !== 'disabled') {
      res.status(400).json({ code: 'conductor.invalid_input', message: "status must be 'enabled' or 'disabled'" });
      return;
    }
    try {
      await deps.workflowStore.setStatus(paramStr(req.params.slug), status);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ code: 'conductor.status_failed', message: errMsg(err) });
    }
  });

  // Start a manual run; returns the (synchronously driven) run plus its step trace.
  router.post('/:slug/runs', async (req: Request, res: Response): Promise<void> => {
    const slug = paramStr(req.params.slug);
    const payload = asObject(asObject(req.body).payload);
    try {
      // Async: the run is created + driven in the background (real agent turns are slow).
      // 202 Accepted; the client polls GET /:slug/runs/:runId for the final status + trace.
      const run = await deps.executor.startRun({ slug, payload, triggerKind: 'manual' });
      const steps = await deps.runStore.stepsForRun(run.id);
      res.status(202).json({ run, steps });
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json({ code: 'conductor.not_found', message: err.message });
      } else if (err instanceof WorkflowDisabledError) {
        res.status(409).json({ code: 'conductor.disabled', message: err.message });
      } else if (err instanceof WorkflowNotPublishedError) {
        res.status(409).json({ code: 'conductor.not_published', message: err.message });
      } else {
        console.error('[conductor] run start failed:', err);
        res.status(500).json({ code: 'conductor.run_failed', message: errMsg(err) });
      }
    }
  });

  // List runs for a workflow's active version.
  router.get('/:slug/runs', async (req: Request, res: Response): Promise<void> => {
    try {
      const wf = await deps.workflowStore.getBySlug(paramStr(req.params.slug));
      if (!wf || !wf.activeVersionId) {
        res.status(404).json({ code: 'conductor.not_found', message: 'workflow or active version missing' });
        return;
      }
      res.json({ runs: await deps.runStore.listForVersion(wf.activeVersionId) });
    } catch (err) {
      res.status(500).json({ code: 'conductor.list_runs_failed', message: errMsg(err) });
    }
  });

  // Single run with its ordered step trace (audit / US9 surface).
  router.get('/:slug/runs/:runId', async (req: Request, res: Response): Promise<void> => {
    try {
      const run = await deps.runStore.get(paramStr(req.params.runId));
      if (!run) {
        res.status(404).json({ code: 'conductor.not_found', message: 'run not found' });
        return;
      }
      const steps = await deps.runStore.stepsForRun(run.id);
      res.json({ run, steps });
    } catch (err) {
      res.status(500).json({ code: 'conductor.get_run_failed', message: errMsg(err) });
    }
  });

  return router;
}
