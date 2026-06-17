import { Router } from 'express';
import type { Request, Response } from 'express';

import { validate } from '@omadia/conductor-core';
import type { JsonObject, WorkflowGraph } from '@omadia/conductor-core';

import type { ConductorWorkflowStore } from './workflowStore.js';
import type { ConductorRunStore } from './runStore.js';
import {
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

export interface ConductorRouterDeps {
  workflowStore: ConductorWorkflowStore;
  runStore: ConductorRunStore;
  executor: ConductorRunExecutor;
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
    const graph = body.graph as WorkflowGraph;
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
      res.status(500).json({ code: 'conductor.publish_failed', message: errMsg(err) });
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
      await deps.workflowStore.setStatus(req.params.slug ?? '', status);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ code: 'conductor.status_failed', message: errMsg(err) });
    }
  });

  // Start a manual run; returns the (synchronously driven) run plus its step trace.
  router.post('/:slug/runs', async (req: Request, res: Response): Promise<void> => {
    const slug = req.params.slug ?? '';
    const payload = asObject(asObject(req.body).payload);
    try {
      const run = await deps.executor.startRun({ slug, payload, triggerKind: 'manual' });
      const steps = await deps.runStore.stepsForRun(run.id);
      res.status(201).json({ run, steps });
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json({ code: 'conductor.not_found', message: err.message });
      } else if (err instanceof WorkflowDisabledError) {
        res.status(409).json({ code: 'conductor.disabled', message: err.message });
      } else if (err instanceof WorkflowNotPublishedError) {
        res.status(409).json({ code: 'conductor.not_published', message: err.message });
      } else {
        res.status(500).json({ code: 'conductor.run_failed', message: errMsg(err) });
      }
    }
  });

  // List runs for a workflow's active version.
  router.get('/:slug/runs', async (req: Request, res: Response): Promise<void> => {
    try {
      const wf = await deps.workflowStore.getBySlug(req.params.slug ?? '');
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
      const run = await deps.runStore.get(req.params.runId ?? '');
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
