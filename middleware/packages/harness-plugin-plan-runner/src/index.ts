/**
 * Public surface of `@omadia/plugin-plan-runner` (#133 plan-as-data, E2).
 *
 * The kernel loads the plugin via `manifest.lifecycle.entry` (`dist/plugin.js`,
 * `activate`). Re-exports here are for tests + programmatic consumers.
 */

export {
  activate,
  pruneTurns,
  pickReusableProcess,
  DEFAULT_PROCESS_REUSE_THRESHOLD,
  type PlanRunnerPluginHandle,
  type ReusableProcess,
} from './plugin.js';
export { shouldPlan, GATE_MODEL } from './gate.js';
export {
  gcSupersededPlans,
  parseIndexArray,
  GC_MODEL,
  type GcInput,
  type GcResult,
} from './gc.js';
export {
  materializePlan,
  materializePlanFromSteps,
  parsePlanSteps,
  summariseRequest,
  PLAN_MODEL,
  type MaterializeInput,
  type MaterializeFromStepsInput,
  type MaterializeResult,
  type ParsedStep,
} from './materializer.js';
export {
  advanceStep,
  applyReplan,
  finishPlan,
  startFirstStep,
  type TurnPlanState,
} from './progress.js';
export {
  exitConditionMet,
  isToolFailure,
  markLatestPlanVerifierBlocked,
  replanRemainder,
  REPLAN_MODEL,
  type ReplanInput,
  type ReplanResult,
} from './replanner.js';
export {
  buildResumePlan,
  type ResumePlan,
  type ResumeStep,
} from './resume.js';
export {
  buildPlanSnapshot,
  type PlanSnapshot,
  type PlanStepSnapshot,
} from './snapshot.js';
