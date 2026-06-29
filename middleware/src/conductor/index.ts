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
import { ConductorRunExecutor } from './runExecutor.js';
import { ConductorAwaitWorker } from './awaitWorker.js';
import { ConductorRunResumeWorker } from './runResumeWorker.js';
import { ConductorScheduleWorker } from './scheduleWorker.js';
import { ConductorEventRouter } from './eventRouter.js';
import { RealStepEffects } from './realStepEffects.js';
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
export { ConductorEventRouter } from './eventRouter.js';
export { StubStepEffects } from './stepEffects.js';
export { RealStepEffects } from './realStepEffects.js';
export type { StepEffects, StepExecution, StepMeta } from './stepEffects.js';
export { createConductorRouter } from './routes.js';

export interface ConductorWiring {
  workflowStore: ConductorWorkflowStore;
  runStore: ConductorRunStore;
  awaitStore: ConductorAwaitStore;
  roleStore: ConductorRoleStore;
  scheduleStore: ConductorScheduleStore;
  executor: ConductorRunExecutor;
  awaitWorker: ConductorAwaitWorker;
  resumeWorker: ConductorRunResumeWorker;
  scheduleWorker: ConductorScheduleWorker;
  eventRouter: ConductorEventRouter;
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
  log?: (msg: string) => void;
}): Promise<ConductorWiring> {
  const log = deps.log ?? (() => undefined);
  await runConductorMigrations(deps.pool, log);

  const workflowStore = new ConductorWorkflowStore(deps.pool);
  const runStore = new ConductorRunStore(deps.pool);
  const awaitStore = new ConductorAwaitStore(deps.pool);
  const roleStore = new ConductorRoleStore(deps.pool);
  const scheduleStore = new ConductorScheduleStore(deps.pool);
  const executor = new ConductorRunExecutor({
    workflowStore,
    runStore,
    awaitStore,
    effects: new RealStepEffects({
      getRegistry: deps.getRegistry,
      ...(deps.invokeAction ? { invokeAction: deps.invokeAction } : {}),
      log,
    }),
    log,
  });

  // Deadline worker — fires the in-graph fallback when a human await times out.
  const awaitWorker = new ConductorAwaitWorker({ awaitStore, executor, log });
  awaitWorker.start();

  // Resume worker — re-drives runs orphaned by a process restart (US2 / SC-002).
  const resumeWorker = new ConductorRunResumeWorker({ runStore, executor, claimerId: randomUUID(), log });
  resumeWorker.start();

  // Schedule worker — fires workflows on their cron triggers (US4 cron).
  const scheduleWorker = new ConductorScheduleWorker({ scheduleStore, executor, log });
  scheduleWorker.start();

  // Event router — a domain event starts every subscribed workflow's run (US4).
  const eventRouter = new ConductorEventRouter({ workflowStore, executor, log });

  deps.app.use(
    '/api/v1/operator/conductors',
    deps.requireAuth,
    createConductorRouter({ workflowStore, runStore, awaitStore, roleStore, scheduleStore, executor, eventRouter, eventCatalog: deps.eventCatalog }),
  );

  return { workflowStore, runStore, awaitStore, roleStore, scheduleStore, executor, awaitWorker, resumeWorker, scheduleWorker, eventRouter };
}
