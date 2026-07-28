import { Router } from 'express';
import type { Request, Response } from 'express';

import { validate } from '@omadia/conductor-core';
import type { JsonObject, KnownRefs, WorkflowGraph } from '@omadia/conductor-core';

import { ConductorBuilderUnavailableError } from './builderAgent.js';
import type { BuilderChatMessage, ConductorBuilderAgent } from './builderAgent.js';
import { emptyGraph } from './graphPatch.js';
import type { ConductorWorkflowStore } from './workflowStore.js';
import type { ConductorRunStore } from './runStore.js';
import { resolveAwaitHolders } from './awaitStore.js';
import type { ConductorAwaitStore } from './awaitStore.js';
import type { ConductorRoleStore } from './roleStore.js';
import type { ConductorScheduleStore } from './scheduleStore.js';
import type { ConductorEventRouter } from './eventRouter.js';
import {
  AwaitNotPendingError,
  AwaitResponderNotHolderError,
  WorkflowDisabledError,
  WorkflowNotFoundError,
  WorkflowNotPublishedError,
} from './runExecutor.js';
import type { ConductorRunExecutor } from './runExecutor.js';
import type { ConductorTemplateStore } from './templateStore.js';
import type { TemplateSummary } from './templateCatalog.js';
import { attachTemplateHints } from './templateHints.js';
import { registerTemplateRoutes } from './templateRoutes.js';

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
  roleStore: ConductorRoleStore;
  scheduleStore: ConductorScheduleStore;
  executor: ConductorRunExecutor;
  eventRouter: ConductorEventRouter;
  /** Read model of declared emittable events (US4) — powers the Designer's event-trigger picker. */
  eventCatalog?: { list(): string[]; byPluginId(): Record<string, string[]> };
  /** Live orchestrator slugs + names — powers the Designer's agent-step picker (dropdown). */
  agentCatalog?: () => Array<{ slug: string; name: string }>;
  /** Registered deterministic-action / tool ids — powers the Designer's action-step picker (dropdown). */
  actionCatalog?: () => string[];
  /** Conversational builder agent (US7) — co-design a draft graph by chat. Optional: absent on hosts without a registry. */
  builderAgent?: ConductorBuilderAgent;
  /** Composite workflow-template catalog (#429 bundled + #478 user/plugin) —
   *  viewer-scoped: pending/shared user templates are visible install-wide,
   *  private ones only to their author. */
  templateCatalog?: {
    list(viewer: string): Promise<TemplateSummary[]>;
    get(id: string, viewer: string): Promise<TemplateSummary | undefined>;
    staticSource(id: string): 'bundled' | 'plugin' | undefined;
  };
  /** DB-backed user-template store (#478) — CRUD + immutable versions + telemetry. */
  templateStore?: ConductorTemplateStore;
  /** Live known-reference sets for strict template validation. */
  templateKnownRefs?: () => Promise<KnownRefs>;
}

/**
 * Operator-facing Conductor API, mounted behind requireAuth at
 * /api/v1/operator/conductors. Lets an operator publish a workflow (graph
 * validated by @omadia/conductor-core before persist), start manual runs, and
 * read the durable run trace.
 */
// Caps on conversational-builder input — the message + history + graph are all inlined verbatim into
// a prompt sent to the LLM up to twice per request, so unbounded input is an authenticated
// cost/latency amplification vector. Generous enough for real workflows, tight enough to bound cost.
const MAX_BUILDER_MESSAGE_CHARS = 8_000;
const MAX_BUILDER_HISTORY_TURNS = 20;
const MAX_BUILDER_GRAPH_BYTES = 200_000;

export function createConductorRouter(deps: ConductorRouterDeps): Router {
  const router = Router();

  // List workflows. Rows with template provenance carry the additive
  // `template` update hint (#478) — viewer-scoped, one catalog read per request.
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const workflows = await deps.workflowStore.list();
      res.json({ workflows: await attachTemplateHints(workflows, deps, req.session?.sub ?? 'operator') });
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
        // Reconcile cron schedules atomically with the publish: a reconcile failure rolls the whole
        // publish back rather than leaving stale schedules firing (e.g. a just-removed cron trigger).
        onPublished: (client, workflowId) => deps.scheduleStore.reconcileOnClient(client, workflowId, graph),
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

  // Event catalog (US4) — the events plugins declared they emit, for the Designer's trigger picker.
  // Registered before '/:slug' so it is not swallowed by the catch-all workflow route.
  router.get('/events/catalog', (_req: Request, res: Response): void => {
    try {
      res.json({ events: deps.eventCatalog?.list() ?? [], byPlugin: deps.eventCatalog?.byPluginId() ?? {} });
    } catch (err) {
      res.status(500).json({ code: 'conductor.event_catalog_failed', message: errMsg(err) });
    }
  });

  // Agent catalog — live orchestrator slugs + names for the Designer's agent-step dropdown.
  // Before '/:slug' so the catch-all workflow route doesn't swallow it.
  router.get('/agents', (_req: Request, res: Response): void => {
    try {
      res.json({ agents: deps.agentCatalog?.() ?? [] });
    } catch (err) {
      res.status(500).json({ code: 'conductor.agent_catalog_failed', message: errMsg(err) });
    }
  });

  // Action catalog — registered deterministic-action / tool ids for the Designer's action-step dropdown.
  router.get('/actions', (_req: Request, res: Response): void => {
    try {
      res.json({ actions: deps.actionCatalog?.() ?? [] });
    } catch (err) {
      res.status(500).json({ code: 'conductor.action_catalog_failed', message: errMsg(err) });
    }
  });

  // Workflow-template routes (#429 catalog/resolve/instantiate + #478 CRUD,
  // versioning, telemetry) — split into templateRoutes.ts for file size. MUST
  // register before the '/:slug' catch-all below.
  registerTemplateRoutes(router, deps);

  // Conversational builder turn (US7): (draft graph + message) → patched draft + reply + validation.
  // Stateless — the draft lives client-side (parity with the visual Designer); this just transforms it.
  // #478 B4 (additive): the response may carry `templateProposals` (≤3) — already filtered inside the
  // agent seam to viewer-visible template ids with prefill vetted against live KnownRefs; the viewer
  // is passed through so the prompt's catalog digest matches what this operator can see.
  router.post('/builder/turn', async (req: Request, res: Response): Promise<void> => {
    if (!deps.builderAgent) {
      res.status(503).json({ code: 'conductor.builder_unavailable', message: 'conversational builder is not wired (no orchestrator registry)' });
      return;
    }
    const body = asObject(req.body);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'message is required' });
      return;
    }
    if (message.length > MAX_BUILDER_MESSAGE_CHARS) {
      res.status(400).json({ code: 'conductor.invalid_input', message: `message exceeds ${String(MAX_BUILDER_MESSAGE_CHARS)} characters` });
      return;
    }
    const graph = (body.graph as unknown as WorkflowGraph | undefined) ?? emptyGraph();
    if (JSON.stringify(graph).length > MAX_BUILDER_GRAPH_BYTES) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'draft graph is too large' });
      return;
    }
    // Keep only well-formed {role,text} turns (a null/garbage element would otherwise crash prompt
    // assembly) and cap to the most recent N so prompt size stays bounded.
    const history: BuilderChatMessage[] = (Array.isArray(body.history) ? body.history : [])
      .filter((m) => {
        const r = asObject(m);
        return typeof r.text === 'string' && (r.role === 'user' || r.role === 'assistant');
      })
      .slice(-MAX_BUILDER_HISTORY_TURNS)
      .map((m) => {
        const r = asObject(m);
        return { role: r.role as 'user' | 'assistant', text: r.text as string };
      });
    try {
      const result = await deps.builderAgent.runTurn({ graph, message, history, viewer: req.session?.sub ?? 'operator' });
      res.json(result);
    } catch (err) {
      if (err instanceof ConductorBuilderUnavailableError) {
        res.status(503).json({ code: 'conductor.builder_unavailable', message: err.message });
      } else {
        console.error('[conductor] builder turn failed:', err);
        res.status(500).json({ code: 'conductor.builder_failed', message: errMsg(err) });
      }
    }
  });

  // Roles + baton management (US6).
  router.get('/roles', async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json({ roles: await deps.roleStore.listRoles() });
    } catch (err) {
      res.status(500).json({ code: 'conductor.roles_failed', message: errMsg(err) });
    }
  });

  router.post('/roles', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const key = typeof body.key === 'string' ? body.key : '';
    const label = typeof body.label === 'string' ? body.label : '';
    if (!key || !label) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'key and label are required' });
      return;
    }
    try {
      await deps.roleStore.createRole({ key, label, description: typeof body.description === 'string' ? body.description : null });
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(500).json({ code: 'conductor.role_create_failed', message: errMsg(err) });
    }
  });

  // Assign (add) or move (unassign) a baton holder.
  router.post('/roles/:key/holders', async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const holderId = typeof body.holderId === 'string' ? body.holderId : '';
    const action = body.action === 'remove' ? 'remove' : 'add';
    if (!holderId) {
      res.status(400).json({ code: 'conductor.invalid_input', message: 'holderId is required' });
      return;
    }
    try {
      const key = paramStr(req.params.key);
      if (action === 'remove') await deps.roleStore.removeHolder(key, holderId);
      else await deps.roleStore.addHolder(key, holderId);
      res.status(200).json({ holders: await deps.roleStore.resolve(key) });
    } catch (err) {
      res.status(500).json({ code: 'conductor.role_assign_failed', message: errMsg(err) });
    }
  });

  // Operator inbox — all pending human awaits across runs, with role principals resolved live.
  router.get('/awaits/pending', async (_req: Request, res: Response): Promise<void> => {
    try {
      const awaits = await deps.awaitStore.listWaiting();
      const enriched = await Promise.all(
        awaits.map(async (aw) => ({
          ...aw, // includes `unreachable` so the operator sees awaits whose holders have no channel binding
          resolvedHolders: await resolveAwaitHolders(aw, (key) => deps.roleStore.resolve(key)),
        })),
      );
      res.json({ awaits: enriched });
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
      } else if (err instanceof AwaitResponderNotHolderError) {
        // A non-holder tried to answer (incl. the phantom `dev_job:<id>` principal an operator
        // must never own). The authz gate already refused; surface it as 403, not a generic 500.
        res.status(403).json({ code: 'conductor.await_forbidden', message: err.message });
      } else {
        console.error('[conductor] respond failed:', err);
        res.status(500).json({ code: 'conductor.respond_failed', message: errMsg(err) });
      }
    }
  });

  // Fetch a workflow + its active version graph (for the visual editor to load).
  // Carries the same additive `template` update hint as the list (#478).
  router.get('/:slug', async (req: Request, res: Response): Promise<void> => {
    try {
      const wf = await deps.workflowStore.getBySlug(paramStr(req.params.slug));
      if (!wf || !wf.activeVersionId) {
        res.status(404).json({ code: 'conductor.not_found', message: 'workflow or active version missing' });
        return;
      }
      const version = await deps.workflowStore.getVersion(wf.activeVersionId);
      const [enriched] = await attachTemplateHints([wf], deps, req.session?.sub ?? 'operator');
      res.json({ workflow: enriched, graph: version?.graph ?? null });
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

  // Dry-run / preview (US8): simulate the path with no side effects, no durable awaits.
  router.post('/:slug/preview', async (req: Request, res: Response): Promise<void> => {
    const slug = paramStr(req.params.slug);
    const body = asObject(req.body);
    try {
      const result = await deps.executor.previewRun(slug, asObject(body.payload), asObject(body.humanResponses));
      res.json(result);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) {
        res.status(404).json({ code: 'conductor.not_found', message: err.message });
      } else if (err instanceof WorkflowNotPublishedError) {
        res.status(409).json({ code: 'conductor.not_published', message: err.message });
      } else {
        console.error('[conductor] preview failed:', err);
        res.status(500).json({ code: 'conductor.preview_failed', message: errMsg(err) });
      }
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
