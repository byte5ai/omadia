/**
 * Public surface of the routines feature. The kernel imports `initRoutines`
 * to wire the whole stack with one call; channel plugins import the
 * `routineTurnContext` helpers to install per-turn context and the
 * `createProactiveSender` adapter to expose their delivery path. The
 * remaining classes / errors are exported for tests and for ad-hoc tooling
 * (smoke scripts, migration backfills, the operator dashboard).
 */

export {
  initRoutines,
  type InitRoutinesOptions,
  type RoutinesHandle,
} from './initRoutines.js';

export {
  routineTurnContext,
} from './routineTurnContext.js';

export {
  createProactiveSender,
} from './genericProactiveSender.js';

export {
  ADAPTIVE_CARD_CONTENT_TYPE,
  ROUTINE_CARD_ACTION_KIND,
  ROUTINE_LIST_FILTER_KIND,
  buildRoutineSmartCard,
  buildRoutineListSmartCard,
  parseRoutineCardAction,
  parseRoutineListFilter,
  type RoutineCardAction,
  type RoutineCardActionPayload,
  type BuildRoutineSmartCardInput,
  type BuildRoutineListSmartCardInput,
  type RoutineListFilter,
  type RoutineListFilterPayload,
  type RoutineRowSummary,
} from './routineSmartCard.js';

export {
  InMemoryProactiveSenderRegistry,
  type ProactiveSender,
  type ProactiveSenderRegistry,
} from './proactiveSender.js';

export {
  ManageRoutineTool,
  MANAGE_ROUTINE_TOOL_NAME,
  manageRoutineToolSpec,
  type ManageRoutineContext,
  type ManageRoutineContextResolver,
  type ManageRoutineInput,
} from './manageRoutineTool.js';

export {
  ROUTINES_AGENT_ID,
  RoutineRunner,
  RoutineNotFoundError,
  RoutineQuotaExceededError,
  UnknownChannelError,
  DEFAULT_MAX_ACTIVE_PER_USER,
  MIN_RUN_INTERVAL_MS,
  type JobSchedulerLike,
  type OrchestratorLike,
  type RoutineRunnerOptions,
} from './routineRunner.js';

export {
  RoutineStore,
  RoutineNameConflictError,
  type Routine,
  type RoutineStatus,
  type RoutineRunStatus,
  type CreateRoutineInput,
  type RecordRunInput,
  type RoutineStoreOptions,
} from './routineStore.js';

export {
  RoutineRunsStore,
  type RoutineRun,
  type RoutineRunTrigger,
  type InsertRoutineRunInput,
  type RoutineRunsStoreOptions,
} from './routineRunsStore.js';

export { runRoutineMigrations } from './migrator.js';

// Phase 5B: factory that wraps a RoutinesHandle into the cross-package
// `routinesIntegration` service contract (defined in `@omadia/plugin-api`).
// The kernel publishes the result; channel plugins consume via
// `ctx.services.get<RoutinesIntegration>(...)` instead of constructor deps.
export { createRoutinesIntegration } from './integration.js';
