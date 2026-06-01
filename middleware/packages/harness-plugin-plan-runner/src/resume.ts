import type { KnowledgeGraph } from '@omadia/plugin-api';

/**
 * #133 (plan-as-data) slice E5 — resume semantics.
 *
 * In this advisory model the orchestrator drives the turn and the plan tracks
 * it, so a plugin cannot inject synthetic tool_results back into the
 * orchestrator's message loop. What it CAN do — and what `buildResumePlan`
 * provides — is a resume DESCRIPTOR for an interrupted turn:
 *   - which steps are already `done` (with their cached evidence),
 *   - the first step to resume from (first `pending`/`in_progress` by order —
 *     `failed`/`skipped` historical steps are ignored; after a replan the
 *     resume point is the recovery path),
 *   - done steps flagged `sideEffecting` that must NOT be re-executed,
 *   - a context block a resumed turn can take as a system hint so it does not
 *     redo completed work.
 *
 * Full orchestrator-level replay (feeding completed-step outputs back into a
 * fresh turn) is a later integration; this is the data it would build on.
 */

export interface ResumeStep {
  stepExternalId: string;
  goal: string;
  resultSummary?: string;
}

export interface ResumePlan {
  planExternalId: string;
  /** `done` steps in order, with cached evidence. */
  completedSteps: ResumeStep[];
  /** First `pending`/`in_progress` step to resume from, or null when the plan
   *  has no remaining work. */
  resumeFromStepExternalId: string | null;
  resumeFromGoal: string | null;
  /** `done` + `sideEffecting` steps — already applied, never replay. */
  sideEffectingDone: ResumeStep[];
  /** An `in_progress` + `sideEffecting` step whose effect may have partially
   *  applied before the interruption — needs human confirmation before
   *  re-attempt. Null when none. */
  ambiguousSideEffectStepExternalId: string | null;
  /** Summary of completed work, for injection as a system hint on resume. */
  resumeContext: string;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function buildResumeContext(
  completed: ResumeStep[],
  resumeFromGoal: string | null,
): string {
  const done =
    completed.length > 0
      ? completed
          .map(
            (s, i) =>
              `${String(i + 1)}. ${s.goal}${
                s.resultSummary ? ` → ${s.resultSummary}` : ''
              }`,
          )
          .join('\n')
      : '(none)';
  const next =
    resumeFromGoal !== null
      ? `Resume from: ${resumeFromGoal}`
      : 'All planned steps are complete.';
  return [
    'This turn resumes an interrupted multi-step plan. Already completed (do NOT redo):',
    done,
    next,
  ].join('\n');
}

/** Build a resume descriptor for a plan, or null when the plan is unknown. */
export async function buildResumePlan(
  planExternalId: string,
  kg: KnowledgeGraph,
): Promise<ResumePlan | null> {
  const plan = await kg.getPlan(planExternalId);
  if (!plan) return null;

  const steps = await kg.getPlanSteps(planExternalId);
  const completedSteps: ResumeStep[] = [];
  const sideEffectingDone: ResumeStep[] = [];
  let resumeFromStepExternalId: string | null = null;
  let resumeFromGoal: string | null = null;
  let ambiguousSideEffectStepExternalId: string | null = null;

  for (const s of steps) {
    const status = s.props['status'];
    const step: ResumeStep = {
      stepExternalId: s.id,
      goal: asString(s.props['goal']),
      ...(typeof s.props['resultSummary'] === 'string'
        ? { resultSummary: s.props['resultSummary'] }
        : {}),
    };
    if (status === 'done') {
      completedSteps.push(step);
      if (s.props['sideEffecting'] === true) sideEffectingDone.push(step);
      continue;
    }
    // `failed` / `skipped` are historical (superseded by replan) — ignored.
    if (status === 'pending' || status === 'in_progress') {
      if (resumeFromStepExternalId === null) {
        resumeFromStepExternalId = s.id;
        resumeFromGoal = step.goal;
      }
      if (status === 'in_progress' && s.props['sideEffecting'] === true) {
        ambiguousSideEffectStepExternalId ??= s.id;
      }
    }
  }

  return {
    planExternalId,
    completedSteps,
    resumeFromStepExternalId,
    resumeFromGoal,
    sideEffectingDone,
    ambiguousSideEffectStepExternalId,
    resumeContext: buildResumeContext(completedSteps, resumeFromGoal),
  };
}
