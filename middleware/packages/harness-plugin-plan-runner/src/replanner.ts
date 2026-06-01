import type { KnowledgeGraph, LlmAccessor } from '@omadia/plugin-api';

import { parsePlanSteps } from './materializer.js';

/**
 * #133 (plan-as-data) slice E4 — replanning.
 *
 * When a step fails (tool error — trigger (a)) or its exit-condition is unmet
 * (trigger (b)), we mark the offending step `failed`, supersede the remaining
 * not-yet-done steps as `skipped`, and ask the model to decompose the
 * REMAINDER into fresh sub-goals appended to the same Plan. Completed steps
 * are kept — the point is to recover, not redo.
 */

export const REPLAN_MODEL = 'claude-haiku-4-5';

/** The orchestrator formats failed tool results as a leading "Error:". This
 *  mirrors that convention so the plugin doesn't need a separate error flag
 *  on the hook payload. */
export function isToolFailure(toolResult: string | undefined): boolean {
  return (
    typeof toolResult === 'string' && toolResult.trimStart().startsWith('Error:')
  );
}

const EXIT_SYSTEM = [
  "You verify whether a step's exit condition is satisfied by a tool result.",
  'Reply with exactly YES (satisfied) or NO (not satisfied). No other text.',
].join('\n');

/** Trigger (b): does the tool result satisfy the step's exit condition?
 *  Defaults to satisfied (no replan) on ambiguity/error to avoid replan
 *  storms. */
export async function exitConditionMet(
  exitCondition: string,
  toolResult: string,
  llm: Pick<LlmAccessor, 'complete'>,
): Promise<boolean> {
  try {
    const res = await llm.complete({
      model: REPLAN_MODEL,
      system: EXIT_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Exit condition: ${exitCondition}\n\nTool result:\n${toolResult.slice(
            0,
            1000,
          )}`,
        },
      ],
      maxTokens: 4,
      temperature: 0,
    });
    return !res.text.trim().toUpperCase().startsWith('NO');
  } catch {
    return true;
  }
}

const REPLAN_SYSTEM = [
  'You are replanning the REMAINDER of a task after a step failed. Given the',
  'original request, the sub-goals already completed, and the failure, produce',
  'a NEW ordered list of the remaining sub-goals (a recovery path — do NOT',
  'repeat completed work). Respond with ONLY a JSON array (no prose, no code',
  'fences) of objects:',
  '  {"goal": string, "exitCondition": string, "dependsOn": number[]}',
  'where dependsOn indices refer to earlier entries IN THIS new array.',
].join('\n');

function buildReplanPrompt(
  userMessage: string,
  completedGoals: string[],
  failedGoal: string | undefined,
  failureReason: string,
): string {
  const done =
    completedGoals.length > 0
      ? completedGoals.map((g, i) => `${String(i + 1)}. ${g}`).join('\n')
      : '(none)';
  return [
    `Original request:\n${userMessage}`,
    `Completed sub-goals:\n${done}`,
    `Failed sub-goal: ${failedGoal ?? '(unknown)'}`,
    `Failure: ${failureReason.slice(0, 500)}`,
    'Plan the remaining sub-goals.',
  ].join('\n\n');
}

export interface ReplanInput {
  planExternalId: string;
  planId: string;
  scope: string;
  userMessage: string;
  /** External id of the step that failed (becomes `failed`). */
  failedStepExternalId: string;
  failureReason: string;
  /** Replan counter for this turn, used to namespace new step ids. */
  generation: number;
  llm: Pick<LlmAccessor, 'complete'>;
  kg: KnowledgeGraph;
}

export interface ReplanResult {
  newStepExternalIds: string[];
}

/** Mark the failed step + supersede the not-done remainder, then append a
 *  freshly-planned remainder. Returns the new step external ids (empty when
 *  the model offered no recovery path — caller then just abandons the plan). */
export async function replanRemainder(
  input: ReplanInput,
): Promise<ReplanResult> {
  const steps = await input.kg.getPlanSteps(input.planExternalId);
  const completedGoals = steps
    .filter((s) => s.props['status'] === 'done')
    .map((s) => String(s.props['goal'] ?? ''));
  const failedGoal = steps.find((s) => s.id === input.failedStepExternalId)
    ?.props['goal'] as string | undefined;

  await input.kg.setPlanStepStatus(input.failedStepExternalId, 'failed', {
    resultSummary: input.failureReason.slice(0, 200),
  });
  // Supersede every other not-yet-done step (the old tail is moot once we
  // re-plan from the failure point).
  for (const s of steps) {
    if (s.id === input.failedStepExternalId) continue;
    if (s.props['status'] !== 'done') {
      await input.kg.setPlanStepStatus(s.id, 'skipped');
    }
  }

  const res = await input.llm.complete({
    model: REPLAN_MODEL,
    system: REPLAN_SYSTEM,
    messages: [
      {
        role: 'user',
        content: buildReplanPrompt(
          input.userMessage,
          completedGoals,
          failedGoal,
          input.failureReason,
        ),
      },
    ],
    maxTokens: 1024,
    temperature: 0,
  });
  const newSteps = parsePlanSteps(res.text);
  if (newSteps.length === 0) return { newStepExternalIds: [] };

  const baseOrder = steps.length;
  const ids = newSteps.map(
    (_, i) => `${input.planId}-r${String(input.generation)}-s${String(i)}`,
  );
  const out: string[] = [];
  for (let i = 0; i < newSteps.length; i++) {
    const step = newSteps[i]!;
    const dependsOnStepIds = step.dependsOn
      .map((idx) => ids[idx])
      .filter((id): id is string => id !== undefined && id !== ids[i]);
    const { stepExternalId } = await input.kg.upsertPlanStep({
      stepId: ids[i]!,
      planId: input.planId,
      scope: input.scope,
      goal: step.goal,
      order: baseOrder + i,
      status: 'pending',
      ...(step.exitCondition ? { exitCondition: step.exitCondition } : {}),
      ...(dependsOnStepIds.length > 0 ? { dependsOnStepIds } : {}),
    });
    out.push(stepExternalId);
  }
  return { newStepExternalIds: out };
}

/**
 * #133 (E6) — record a verifier block on the scope's most-recent plan: mark
 * its last executed (`done`) step `failed` with the block reason. Advisory —
 * the verifier runs its own retry; this only surfaces the rejection on the
 * plan (e.g. in the graph view). Returns the marked step's external id, or
 * null when there is no plan/step to mark.
 */
export async function markLatestPlanVerifierBlocked(
  scope: string,
  reason: string,
  kg: KnowledgeGraph,
): Promise<string | null> {
  const plans = await kg.listPlansForScope(scope);
  const latest = plans[0];
  if (!latest) return null;
  const steps = await kg.getPlanSteps(latest.id);
  const lastDone = [...steps]
    .reverse()
    .find((s) => s.props['status'] === 'done');
  const target = lastDone ?? steps[steps.length - 1];
  if (!target) return null;
  await kg.setPlanStepStatus(target.id, 'failed', {
    resultSummary: `verifier blocked: ${reason}`.slice(0, 200),
  });
  return target.id;
}
