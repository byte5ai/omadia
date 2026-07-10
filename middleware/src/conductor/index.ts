import { randomUUID } from 'node:crypto';

import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { OrchestratorRegistry } from '@omadia/orchestrator';
import type { KnownRefs } from '@omadia/conductor-core';

import { runConductorMigrations } from './migrator.js';
import { ConductorWorkflowStore } from './workflowStore.js';
import { ConductorRunStore } from './runStore.js';
import { ConductorAwaitStore } from './awaitStore.js';
import type { ConductorAwait } from './awaitStore.js';
import type { ApprovalReminder } from '@omadia/plugin-api';
import { ConductorRoleStore } from './roleStore.js';
import { ConductorScheduleStore } from './scheduleStore.js';
import { ConductorChannelBindingStore } from './channelBindingStore.js';
import { ConductorRunExecutor } from './runExecutor.js';
import { ConductorAwaitWorker } from './awaitWorker.js';
import type { ProactiveSenderLike } from './awaitWorker.js';
import { ConductorRunResumeWorker } from './runResumeWorker.js';
import { ConductorScheduleWorker } from './scheduleWorker.js';
import { ConductorEventRouter } from './eventRouter.js';
import { RealStepEffects } from './realStepEffects.js';
import { ConductorBuilderAgent } from './builderAgent.js';
import { createCompositeTemplateCatalog, loadTemplateCatalog } from './templateCatalog.js';
import type { CompositeTemplateCatalog } from './templateCatalog.js';
import { createTemplateStore } from './templateStore.js';
import type { ConductorTemplateStore } from './templateStore.js';
import { createConductorRouter } from './routes.js';

export { runConductorMigrations } from './migrator.js';
export { ConductorWorkflowStore } from './workflowStore.js';
export { ConductorRunStore } from './runStore.js';
export { ConductorAwaitStore } from './awaitStore.js';
export { ConductorRoleStore } from './roleStore.js';
export { ConductorRunExecutor, AwaitNotPendingError, AwaitResponderNotHolderError } from './runExecutor.js';
export { ConductorAwaitWorker } from './awaitWorker.js';
export { ConductorRunResumeWorker } from './runResumeWorker.js';
export { ConductorScheduleWorker } from './scheduleWorker.js';
export { ConductorScheduleStore } from './scheduleStore.js';
export { ConductorChannelBindingStore } from './channelBindingStore.js';
export { ConductorEventRouter } from './eventRouter.js';
export { StubStepEffects } from './stepEffects.js';
export { RealStepEffects } from './realStepEffects.js';
export type { StepEffects, StepExecution, StepMeta } from './stepEffects.js';
export { ConductorBuilderAgent, ConductorBuilderUnavailableError } from './builderAgent.js';
export type { ConductorBuilderTurnInput, ConductorBuilderTurnResult, BuilderChatMessage, TemplateProposal } from './builderAgent.js';
export { applyGraphPatches, emptyGraph } from './graphPatch.js';
export type { GraphPatch } from './graphPatch.js';
export { createConductorRouter } from './routes.js';
export { createTemplateStore, TemplateIdExistsError, TemplateInvalidError } from './templateStore.js';
export type { ConductorTemplateStore, TemplateRecord, TemplateStatus } from './templateStore.js';
export { createCompositeTemplateCatalog, loadTemplateCatalog, userTemplateVisible } from './templateCatalog.js';
export type { CompositeTemplateCatalog, TemplateSummary } from './templateCatalog.js';

export interface ConductorWiring {
  workflowStore: ConductorWorkflowStore;
  runStore: ConductorRunStore;
  awaitStore: ConductorAwaitStore;
  roleStore: ConductorRoleStore;
  scheduleStore: ConductorScheduleStore;
  channelBindingStore: ConductorChannelBindingStore;
  executor: ConductorRunExecutor;
  awaitWorker: ConductorAwaitWorker;
  resumeWorker: ConductorRunResumeWorker;
  scheduleWorker: ConductorScheduleWorker;
  eventRouter: ConductorEventRouter;
  builderAgent: ConductorBuilderAgent;
  /** DB-backed user-template store (#478). */
  templateStore: ConductorTemplateStore;
  /** Composite template catalog (bundled + user + plugin) — its plugin
   *  registration seam is what the plugin install service feeds (#478). */
  templateCatalog: CompositeTemplateCatalog;
}

/**
 * Wire the Conductor subsystem into the kernel: run its migrations, construct its stores +
 * run executor (stub step effects for now), and mount the operator API behind requireAuth.
 * Called from the kernel boot inside the `graphPool` block — Conductor is inert on the
 * in-memory backend (no pool), exactly like routines / agent_schedules.
 */
export async function wireConductor(deps: {
  pool: Pool;
  app: Express;
  requireAuth: RequestHandler;
  /** resolves an Agent (orchestrator instance) by slug for agent steps. */
  getRegistry: () => OrchestratorRegistry | undefined;
  /** invokes a deterministic-action / connector tool by id for action steps. */
  invokeAction?: (toolId: string, input: unknown) => Promise<string | undefined>;
  /** lists registered deterministic-action / tool ids for the Designer's action-step picker. */
  listActions?: () => string[];
  /** read model of the event-emit catalog (declared `event_emit` capabilities) for the Designer. */
  eventCatalog?: { list(): string[]; byPluginId(): Record<string, string[]> };
  /** resolves a proactive sender for a channel (US5 reminders) — from the routines senderRegistry. */
  getProactiveSender?: (channel: string) => ProactiveSenderLike | undefined;
  log?: (msg: string) => void;
}): Promise<ConductorWiring> {
  const log = deps.log ?? (() => undefined);
  await runConductorMigrations(deps.pool, log);

  const workflowStore = new ConductorWorkflowStore(deps.pool);
  const runStore = new ConductorRunStore(deps.pool);
  const awaitStore = new ConductorAwaitStore(deps.pool);
  const roleStore = new ConductorRoleStore(deps.pool);
  const scheduleStore = new ConductorScheduleStore(deps.pool);
  const channelBindingStore = new ConductorChannelBindingStore(deps.pool);
  const executor = new ConductorRunExecutor({
    workflowStore,
    runStore,
    awaitStore,
    effects: new RealStepEffects({
      getRegistry: deps.getRegistry,
      ...(deps.invokeAction ? { invokeAction: deps.invokeAction } : {}),
      log,
    }),
    resolveRoleHolders: (key) => roleStore.resolve(key), // quorum='all' required-responder resolution
    log,
  });

  // Enriches a reminder with the structured approval payload (WHAT is being approved + the
  // workflow's current step/progress) so a channel that renders a rich approve/reject card can.
  // Best-effort: any miss returns undefined and the reminder still delivers its text fallback.
  const describeApproval = async (aw: ConductorAwait): Promise<ApprovalReminder | undefined> => {
    try {
      const run = await runStore.get(aw.runId);
      if (!run) return undefined;
      const version = await workflowStore.getVersion(run.workflowVersionId);
      if (!version) return undefined;
      const workflow = await workflowStore.getById(version.workflowId);
      // NB: we intentionally do NOT derive a "step X of Y" from `version.graph.steps` — that array is
      // authoring order, not execution order (the graph branches via transitions), so a fraction would
      // misread as linear progress. stepIndex/totalSteps stay reserved for a future run-trace-based
      // computation (review M2). "Where we are" is conveyed by the current step label.
      return {
        awaitId: aw.id,
        runId: aw.runId,
        question: aw.message,
        workflowName: workflow?.name || workflow?.slug || 'Workflow',
        stepLabel: aw.stepId,
        quorum: aw.quorum,
      };
    } catch {
      return undefined; // never block a reminder on enrichment
    }
  };

  // Deadline + reminder worker — fires the in-graph fallback on timeout (US5) and nudges waiting
  // holders on their channel when a reminder interval elapses (reminder deps optional / graphPool-gated).
  const awaitWorker = new ConductorAwaitWorker({
    awaitStore,
    executor,
    bindingStore: channelBindingStore,
    resolveRoleHolders: (key) => roleStore.resolve(key),
    ...(deps.getProactiveSender ? { getProactiveSender: deps.getProactiveSender } : {}),
    describeApproval,
    log,
  });
  awaitWorker.start();

  // Resume worker — re-drives runs orphaned by a process restart (US2 / SC-002).
  const resumeWorker = new ConductorRunResumeWorker({ runStore, executor, claimerId: randomUUID(), log });
  resumeWorker.start();

  // Schedule worker — fires workflows on their cron triggers (US4 cron).
  const scheduleWorker = new ConductorScheduleWorker({ scheduleStore, executor, log });
  scheduleWorker.start();

  // Event router — a domain event starts every subscribed workflow's run (US4).
  const eventRouter = new ConductorEventRouter({ workflowStore, executor, log });

  // Template surface (#429 bundled files + #478 DB store): one composite,
  // viewer-scoped catalog over both, plus the plugin registration seam.
  const templateStore = createTemplateStore(deps.pool, log);
  const templateCatalog = createCompositeTemplateCatalog({
    bundled: loadTemplateCatalog({ log }),
    store: templateStore,
    log,
  });

  // Live known-reference sets, shared by the STRICT template validation on the
  // resolve/instantiate routes AND the builder's proposal-prefill vetting (#478 B4)
  // — one definition so the two gates can never drift apart.
  const templateKnownRefs = async (): Promise<KnownRefs> => ({
    agentIds: (deps.getRegistry()?.list() ?? []).map((a) => a.agent.slug),
    actionIds: deps.listActions?.() ?? [],
    roleKeys: (await roleStore.listRoles()).map((r) => r.key),
    eventIds: deps.eventCatalog?.list() ?? [],
  });

  // Conversational builder agent (US7) — drives draft co-design via a registry Agent turn. Known
  // refs are sourced live from the event catalog so the builder + validate can flag unknown events.
  // #478 B4: the viewer-scoped composite catalog feeds its prompt digest + proposal allowlist.
  const builderAgent = new ConductorBuilderAgent({
    getRegistry: deps.getRegistry,
    knownRefs: () => ({ eventIds: deps.eventCatalog?.list() ?? [] }),
    templateCatalog,
    templateKnownRefs,
    log,
  });

  deps.app.use(
    '/api/v1/operator/conductors',
    deps.requireAuth,
    createConductorRouter({
      workflowStore,
      runStore,
      awaitStore,
      roleStore,
      scheduleStore,
      executor,
      eventRouter,
      eventCatalog: deps.eventCatalog,
      // Live agent/action catalogs for the Designer's step pickers (dropdowns).
      agentCatalog: () => (deps.getRegistry()?.list() ?? []).map((a) => ({ slug: a.agent.slug, name: a.agent.name })),
      ...(deps.listActions ? { actionCatalog: deps.listActions } : {}),
      builderAgent,
      // Composite workflow-template catalog (#429 bundled + #478 user/plugin) + DB store.
      templateCatalog,
      templateStore,
      // Live known-reference sets for the STRICT template validation (stricter than 'POST /'
      // on purpose: a template instance must be runnable, not merely well-formed).
      templateKnownRefs,
    }),
  );

  return { workflowStore, runStore, awaitStore, roleStore, scheduleStore, channelBindingStore, executor, awaitWorker, resumeWorker, scheduleWorker, eventRouter, builderAgent, templateStore, templateCatalog };
}
