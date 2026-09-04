import type {
  JsonObject,
  JsonValue,
  Step,
  TriggerKind,
} from '@omadia/conductor-core';

export interface StepExecution {
  /** the step's result, fed to the engine as `stepResult` for guard/postcondition evaluation. */
  result: JsonValue;
  /** audit actor record persisted on the run step. */
  actor: JsonValue;
}

/** Per-call context the executor passes to effects (for session bucketing / tracing). */
export interface StepMeta {
  runId: string;
  /**
   * How this run was started. Present so an effect can tell a run that a HUMAN
   * or a schedule began from one a CHANNEL began — the two carry different
   * authority, and only the second one has an addressed bot whose permissions
   * the work must stay inside.
   *
   * Optional so every existing caller (preview, tests, the resume worker's
   * older shape) keeps compiling and keeps its current behaviour: absent means
   * "not channel-triggered", which is what those callers are.
   */
  triggerKind?: TriggerKind;
  /** The domain event that started the run (`teams.message.posted`, …), when
   *  it was an event/webhook trigger. Names WHICH channel, so the origin rule
   *  applies only to channels that actually carry an addressed bot. */
  triggerEventId?: string;
  /**
   * The run's workflow id. A `say` step's floor is derived from it: the target
   * conversation's ephemeral attachment must belong to THIS workflow. Optional
   * for the same back-compat reason as the fields above — preview runs and
   * tests have no workflow row, and a say there simply finds no floor.
   */
  workflowId?: string | null;
}

/**
 * The I/O side of step execution, injected into the run executor. Production wires real
 * orchestrator turns / connector actions (RealStepEffects); preview (US8) and tests wire fakes.
 * This is the seam that lets the deterministic engine stay pure while the executor performs
 * side effects.
 */
export interface StepEffects {
  runAgentStep(step: Step, context: JsonObject, meta: StepMeta): Promise<StepExecution>;
  runActionStep(step: Step, context: JsonObject, meta: StepMeta): Promise<StepExecution>;
}

/**
 * First-slice default: deterministic, dependency-free execution that records the step and
 * returns a synthetic result. Proves the wiring (API → engine → persistence → audit) end to
 * end in the live kernel without an LLM or an installed connector. Real agent-turn and
 * connector-action execution replace these two methods in a later phase.
 */
export class StubStepEffects implements StepEffects {
  async runAgentStep(step: Step, _context: JsonObject, _meta: StepMeta): Promise<StepExecution> {
    return {
      result: { stub: true, kind: 'agent', agentId: step.agentId ?? null },
      actor: { kind: 'agent', agentId: step.agentId ?? null },
    };
  }

  async runActionStep(step: Step, _context: JsonObject, _meta: StepMeta): Promise<StepExecution> {
    return {
      result: { stub: true, kind: 'action', actionId: step.actionId ?? null },
      actor: { kind: 'action', actionId: step.actionId ?? null },
    };
  }
}
