import type { KnowledgeGraph } from '@omadia/plugin-api';

/**
 * #133 (plan-as-data) slice E3 — in-turn progress tracking.
 *
 * The plan is advisory: the orchestrator's tool loop is driven by the LLM,
 * not by the plan. We map tool activity to plan steps with a simple
 * sequential cursor — the i-th tool call advances the i-th step. This is a
 * heuristic (one tool ≈ one step), good enough to surface live progress and
 * to satisfy the "inspect a turn as a plan structure" goal; a precise mapping
 * (e.g. LLM- or evidence-driven) is a later refinement.
 */

export interface TurnPlanState {
  readonly stepExternalIds: readonly string[];
  /** Index of the step currently in progress. */
  cursor: number;
}

/** Mark the cursor step `in_progress` (called once after materialisation). */
export async function startFirstStep(
  state: TurnPlanState,
  kg: KnowledgeGraph,
): Promise<void> {
  const first = state.stepExternalIds[state.cursor];
  if (first !== undefined) {
    await kg.setPlanStepStatus(first, 'in_progress');
  }
}

/** Mark the cursor step `done` (with optional evidence), advance, and mark
 *  the next step `in_progress`. No-op once the cursor runs past the last step
 *  (more tool calls than planned steps — the plan under-counted). */
export async function advanceStep(
  state: TurnPlanState,
  kg: KnowledgeGraph,
  evidence?: { resultSummary?: string },
): Promise<void> {
  const current = state.stepExternalIds[state.cursor];
  if (current === undefined) return;
  await kg.setPlanStepStatus(
    current,
    'done',
    evidence?.resultSummary !== undefined
      ? { resultSummary: evidence.resultSummary }
      : undefined,
  );
  state.cursor += 1;
  const next = state.stepExternalIds[state.cursor];
  if (next !== undefined) {
    await kg.setPlanStepStatus(next, 'in_progress');
  }
}

/** At turn end, mark the still-in-progress cursor step `done` (the turn
 *  produced its answer). Steps never reached stay `pending` — an honest
 *  record that the plan over-counted. */
export async function finishPlan(
  state: TurnPlanState,
  kg: KnowledgeGraph,
): Promise<void> {
  const current = state.stepExternalIds[state.cursor];
  if (current !== undefined) {
    await kg.setPlanStepStatus(current, 'done');
  }
}
