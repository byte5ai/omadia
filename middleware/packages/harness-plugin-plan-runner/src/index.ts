/**
 * Public surface of `@omadia/plugin-plan-runner` (#133 plan-as-data, E2).
 *
 * The kernel loads the plugin via `manifest.lifecycle.entry` (`dist/plugin.js`,
 * `activate`). Re-exports here are for tests + programmatic consumers.
 */

export { activate, type PlanRunnerPluginHandle } from './plugin.js';
export { shouldPlan, GATE_MODEL } from './gate.js';
export {
  materializePlan,
  parsePlanSteps,
  PLAN_MODEL,
  type MaterializeInput,
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
  replanRemainder,
  REPLAN_MODEL,
  type ReplanInput,
  type ReplanResult,
} from './replanner.js';
