import type { Pool } from 'pg';

import type { JobScheduler } from '../jobScheduler.js';
import {
  ManageRoutineTool,
  manageRoutineToolSpec,
  MANAGE_ROUTINE_TOOL_NAME,
} from './manageRoutineTool.js';
import { runRoutineMigrations } from './migrator.js';
import {
  InMemoryProactiveSenderRegistry,
  type ProactiveSender,
} from './proactiveSender.js';
import {
  RoutineRunner,
  type OrchestratorLike,
} from './routineRunner.js';
import { RoutineRunsStore } from './routineRunsStore.js';
import { RoutineStore } from './routineStore.js';
import { routineTurnContext } from './routineTurnContext.js';

/**
 * Single-call wiring for the routines feature. The kernel calls this once
 * after the Postgres pool, the JobScheduler, and the ChatAgent are
 * available; everything below the surface is created here so `index.ts`
 * stays thin.
 *
 * Lifecycle:
 *   - Runs DB migrations (idempotent — `_routine_migrations` tracks).
 *   - Wires the `manage_routine` native tool into the orchestrator's
 *     registry (returns the dispose handle the kernel's shutdown sequence
 *     should call).
 *   - Loads every active routine via `runner.start()` and registers it
 *     with the in-memory `JobScheduler`.
 *
 * Channel plugins (Teams, Telegram, …) register their proactive senders
 * via the returned `senderRegistry` BEFORE `runner.start()` is called.
 * That ordering is honoured by passing senders in `opts.proactiveSenders`.
 *
 * Channel plugins MUST also wrap inbound turns with
 * `withRoutineContext({tenant, userId, channel, conversationRef}, fn)` so
 * the `manage_routine` tool can attribute `create` calls and capture the
 * delivery handle. Without it, `create` returns an `Error: …` string and
 * the model degrades gracefully.
 */
export interface InitRoutinesOptions {
  pool: Pool;
  scheduler: JobScheduler;
  /**
   * Real `Orchestrator` (typically `chatAgentBundle.raw`). The runner
   * needs the lower-level `runTurn` (not the higher-level `chat`) so it
   * can persist the per-turn `runTrace` for the call-stack viewer. The
   * structural type keeps this layer free of a hard import on the
   * orchestrator package.
   */
  orchestrator: OrchestratorLike;
  /**
   * Native-tool registration surface. Production passes the kernel-owned
   * `nativeToolRegistry`. The shape is the minimum used here so a stub
   * fits in tests without pulling the orchestrator package.
   */
  registerNativeTool: (
    name: string,
    handler: (input: unknown) => Promise<string>,
    options: {
      spec: typeof manageRoutineToolSpec;
      promptDoc?: string;
    },
  ) => () => void;
  /** Optional proactive senders the runner should know at boot. Channel
   *  plugins typically push more in via `senderRegistry.register()` after
   *  initRoutines returns and before `runner.start()` — pass them here
   *  when the kernel knows them upfront. */
  proactiveSenders?: ProactiveSender[];
  log?: (msg: string) => void;
  /** Override the per-user active-routine cap. */
  maxActivePerUser?: number;
}

export interface RoutinesHandle {
  store: RoutineStore;
  runsStore: RoutineRunsStore;
  runner: RoutineRunner;
  senderRegistry: InMemoryProactiveSenderRegistry;
  tool: ManageRoutineTool;
  /** Compose with kernel shutdown — disposes the tool registration and
   *  stops every running routine. */
  close(): void;
}

export async function initRoutines(
  opts: InitRoutinesOptions,
): Promise<RoutinesHandle> {
  const log = opts.log ?? ((m) => console.log(m));

  await runRoutineMigrations(opts.pool, log);

  const store = new RoutineStore({ pool: opts.pool, log });
  const runsStore = new RoutineRunsStore({ pool: opts.pool, log });
  const senderRegistry = new InMemoryProactiveSenderRegistry();
  for (const sender of opts.proactiveSenders ?? []) {
    senderRegistry.register(sender);
  }

  const runner = new RoutineRunner({
    store,
    runsStore,
    scheduler: opts.scheduler,
    orchestrator: opts.orchestrator,
    senderRegistry,
    log,
    maxActivePerUser: opts.maxActivePerUser,
  });

  const tool = new ManageRoutineTool({
    runner,
    resolveContext: () => routineTurnContext.current(),
  });

  const disposeTool = opts.registerNativeTool(
    MANAGE_ROUTINE_TOOL_NAME,
    (input) => tool.handle(input),
    { spec: manageRoutineToolSpec },
  );

  // Note: `runner.start()` is NOT called here. The caller MUST invoke
  // `handle.runner.start()` AFTER every channel plugin has activated and
  // registered its `ProactiveSender` into `handle.senderRegistry` —
  // otherwise the catch-up logic in start() can fire a routine before
  // its delivery channel exists, which records a "no sender" error.
  // index.ts does this explicitly after `channelRegistry.activateAllInstalled()`.

  return {
    store,
    runsStore,
    runner,
    senderRegistry,
    tool,
    close(): void {
      disposeTool();
      runner.stop();
    },
  };
}
