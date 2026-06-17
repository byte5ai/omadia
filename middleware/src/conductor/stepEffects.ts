import type { JsonObject, JsonValue, Step } from '@omadia/conductor-core';

export interface StepExecution {
  /** the step's result, fed to the engine as `stepResult` for guard/postcondition evaluation. */
  result: JsonValue;
  /** audit actor record persisted on the run step. */
  actor: JsonValue;
}

/**
 * The I/O side of step execution, injected into the run executor. Production wires real
 * orchestrator turns / connector actions; preview (US8) and tests wire fakes. This is the
 * seam that lets the deterministic engine stay pure while the executor performs side effects.
 */
export interface StepEffects {
  runAgentStep(step: Step, context: JsonObject): Promise<StepExecution>;
  runActionStep(step: Step, context: JsonObject): Promise<StepExecution>;
}

/**
 * First-slice default: deterministic, dependency-free execution that records the step and
 * returns a synthetic result. Proves the wiring (API → engine → persistence → audit) end to
 * end in the live kernel without an LLM or an installed connector. Real agent-turn and
 * connector-action execution replace these two methods in a later phase.
 */
export class StubStepEffects implements StepEffects {
  async runAgentStep(step: Step, _context: JsonObject): Promise<StepExecution> {
    return {
      result: { stub: true, kind: 'agent', agentId: step.agentId ?? null },
      actor: { kind: 'agent', agentId: step.agentId ?? null },
    };
  }

  async runActionStep(step: Step, _context: JsonObject): Promise<StepExecution> {
    return {
      result: { stub: true, kind: 'action', actionId: step.actionId ?? null },
      actor: { kind: 'action', actionId: step.actionId ?? null },
    };
  }
}
