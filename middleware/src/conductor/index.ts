import { randomUUID } from 'node:crypto';

import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { OrchestratorRegistry } from '@omadia/orchestrator';

import { runConductorMigrations } from './migrator.js';
import { ConductorWorkflowStore } from './workflowStore.js';
import { ConductorRunStore } from './runStore.js';
import { ConductorAwaitStore } from './awaitStore.js';
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
import { createConductorRouter } from './routes.js';

export { runConductorMigrations } from './migrator.js';
export { ConductorWorkflowStore } from './workflowStore.js';
export { ConductorRunStore } from './runStore.js';
export { ConductorAwaitStore } from './awaitStore.js';
export { ConductorRoleStore } from './roleStore.js';
export { ConductorRunExecutor } from './runExecutor.js';
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
export type { ConductorBuilderTurnInput, ConductorBuilderTurnResult, BuilderChatMessage } from './builderAgent.js';
export { applyGraphPatches, emptyGraph } from './graphPatch.js';
export type { GraphPatch } from './graphPatch.js';
export { createConductorRouter } from './routes.js';

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

  // Deadline + reminder worker — fires the in-graph fallback on timeout (US5) and nudges waiting
  // holders on their channel when a reminder interval elapses (reminder deps optional / graphPool-gated).
  const awaitWorker = new ConductorAwaitWorker({
    awaitStore,
    executor,
    bindingStore: channelBindingStore,
    resolveRoleHolders: (key) => roleStore.resolve(key),
    ...(deps.getProactiveSender ? { getProactiveSender: deps.getProactiveSender } : {}),
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

  // Conversational builder agent (US7) — drives draft co-design via a registry Agent turn. Known
  // refs are sourced live from the event catalog so the builder + validate can flag unknown events.
  const builderAgent = new ConductorBuilderAgent({
    getRegistry: deps.getRegistry,
    knownRefs: () => ({ eventIds: deps.eventCatalog?.list() ?? [] }),
    log,
  });

  deps.app.use(
    '/api/v1/operator/conductors',
    deps.requireAuth,
    createConductorRouter({ workflowStore, runStore, awaitStore, roleStore, scheduleStore, executor, eventRouter, eventCatalog: deps.eventCatalog, builderAgent }),
  );

  return { workflowStore, runStore, awaitStore, roleStore, scheduleStore, channelBindingStore, executor, awaitWorker, resumeWorker, scheduleWorker, eventRouter, builderAgent };
}
