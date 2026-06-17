import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { OrchestratorRegistry } from '@omadia/orchestrator';

import { runConductorMigrations } from './migrator.js';
import { ConductorWorkflowStore } from './workflowStore.js';
import { ConductorRunStore } from './runStore.js';
import { ConductorRunExecutor } from './runExecutor.js';
import { RealStepEffects } from './realStepEffects.js';
import { createConductorRouter } from './routes.js';

export { runConductorMigrations } from './migrator.js';
export { ConductorWorkflowStore } from './workflowStore.js';
export { ConductorRunStore } from './runStore.js';
export { ConductorRunExecutor } from './runExecutor.js';
export { StubStepEffects } from './stepEffects.js';
export { RealStepEffects } from './realStepEffects.js';
export type { StepEffects, StepExecution, StepMeta } from './stepEffects.js';
export { createConductorRouter } from './routes.js';

export interface ConductorWiring {
  workflowStore: ConductorWorkflowStore;
  runStore: ConductorRunStore;
  executor: ConductorRunExecutor;
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
  log?: (msg: string) => void;
}): Promise<ConductorWiring> {
  const log = deps.log ?? (() => undefined);
  await runConductorMigrations(deps.pool, log);

  const workflowStore = new ConductorWorkflowStore(deps.pool);
  const runStore = new ConductorRunStore(deps.pool);
  const executor = new ConductorRunExecutor({
    workflowStore,
    runStore,
    effects: new RealStepEffects({
      getRegistry: deps.getRegistry,
      ...(deps.invokeAction ? { invokeAction: deps.invokeAction } : {}),
      log,
    }),
    log,
  });

  deps.app.use(
    '/api/v1/operator/conductors',
    deps.requireAuth,
    createConductorRouter({ workflowStore, runStore, executor }),
  );

  return { workflowStore, runStore, executor };
}
