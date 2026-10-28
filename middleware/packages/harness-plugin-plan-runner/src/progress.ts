import { PLAN_STEP_ANSWER_EVIDENCE, type KnowledgeGraph } from '@omadia/plugin-api';

/**
 * #133 (plan-as-data) slice E3 — in-turn progress tracking.
 *
 * The plan is advisory: the orchestrator's tool loop is driven by the LLM,
 * not by the plan. We map tool activity to plan steps with a simple
 * sequential cursor — the i-th successful work call advances the i-th step.
 * This is a heuristic (one tool ≈ one step), good enough to surface live
 * progress and to satisfy the "inspect a turn as a plan structure" goal; a
 * precise mapping (e.g. LLM- or evidence-driven) is a later refinement.
 *
 * #1502 — the cursor only moves on real work: the plugin skips bookkeeping
 * calls (memory, answer rendering) and routes failed calls to the replanner.
 * Invariant: every step before the cursor is `done`. At turn end only the
 * last step may still be completed by the answer itself; every other step
 * the turn did not reach ends `skipped`, so neither the plan card nor plan
 * recall reports work that never ran.
 */

export interface TurnPlanState {
  /** Ordered step external ids; spliced by {@link applyReplan} on recovery. */
  stepExternalIds: string[];
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

/** Evidence recorded on a step the turn ended without reaching. */
export const NOT_REACHED_SUMMARY = 'not reached: the turn ended before this step ran';

/** At turn end, close the steps from the cursor on (#1502). The answer
 *  completes the last step when every step before it is done (the typical
 *  "present the results" step needs no tool). Any other step the turn did not
 *  reach — including one left `in_progress` because its call never came —
 *  ends `skipped`, never `done`. */
export async function finishPlan(
  state: TurnPlanState,
  kg: KnowledgeGraph,
): Promise<void> {
  const lastIndex = state.stepExternalIds.length - 1;
  for (let i = state.cursor; i <= lastIndex; i++) {
    const id = state.stepExternalIds[i]!;
    // Only the last step, and only when it is the sole step still open.
    if (i === lastIndex && i === state.cursor) {
      await kg.setPlanStepStatus(id, 'done', {
        resultSummary: PLAN_STEP_ANSWER_EVIDENCE,
      });
    } else {
      await kg.setPlanStepStatus(id, 'skipped', {
        resultSummary: NOT_REACHED_SUMMARY,
      });
    }
  }
  state.cursor = state.stepExternalIds.length;
}

/** A failed step left no recovery path: the replanner already marked it
 *  `failed` and the rest `skipped`, so park the cursor past the end — later
 *  calls and {@link finishPlan} must not touch the plan again. */
export function abandonPlan(state: TurnPlanState): void {
  state.cursor = state.stepExternalIds.length;
}

/** #133 (E4) — after a replan produced `newStepExternalIds`, splice them in:
 *  keep the already-completed steps before the cursor, drop the failed +
 *  superseded tail, append the new steps, and arm the first new step. The
 *  KG-side status changes (failed / skipped) are done by the replanner; this
 *  only rewires the in-turn cursor. */
export async function applyReplan(
  state: TurnPlanState,
  newStepExternalIds: string[],
  kg: KnowledgeGraph,
): Promise<void> {
  const kept = state.stepExternalIds.slice(0, state.cursor);
  state.stepExternalIds = [...kept, ...newStepExternalIds];
  state.cursor = kept.length;
  const next = state.stepExternalIds[state.cursor];
  if (next !== undefined) {
    await kg.setPlanStepStatus(next, 'in_progress');
  }
}
