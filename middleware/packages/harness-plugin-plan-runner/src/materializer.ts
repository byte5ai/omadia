import type { KnowledgeGraph, LlmAccessor } from '@omadia/plugin-api';

/**
 * #133 (plan-as-data) slice E2 — plan materialisation.
 *
 * Asks Haiku to decompose a plan-worthy request into an ordered list of
 * typed sub-goals, then persists them as a `Plan` + `PlanStep` DAG via the
 * knowledge-graph contract added in E1. The plan is materialised BEFORE the
 * turn executes, so later slices (E3+) can check progress against it.
 */

export const PLAN_MODEL = 'claude-haiku-4-5';

const PLAN_SYSTEM = [
  'You decompose a user request into an ordered list of concrete sub-goals',
  'for an AI assistant to execute. Keep it minimal — only the steps that are',
  'genuinely distinct. Respond with ONLY a JSON array (no prose, no code',
  'fences) of objects with this shape:',
  '  {"goal": string, "exitCondition": string, "dependsOn": number[]}',
  'where `dependsOn` holds the 0-based indices of prerequisite steps earlier',
  'in the array (use [] when a step has no prerequisites).',
].join('\n');

export interface ParsedStep {
  goal: string;
  exitCondition?: string;
  dependsOn: number[];
}

/** Tolerant parse of the model's plan output: strips code fences, parses the
 *  JSON array, and keeps only well-formed `{goal}` entries. Returns [] on any
 *  failure so a malformed plan degrades to "no plan" rather than throwing. */
export function parsePlanSteps(raw: string): ParsedStep[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const steps: ParsedStep[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const goal = typeof rec['goal'] === 'string' ? rec['goal'].trim() : '';
    if (goal.length === 0) continue;
    const dependsOn = Array.isArray(rec['dependsOn'])
      ? rec['dependsOn'].filter((n): n is number => Number.isInteger(n))
      : [];
    steps.push({
      goal,
      ...(typeof rec['exitCondition'] === 'string'
        ? { exitCondition: rec['exitCondition'] }
        : {}),
      dependsOn,
    });
  }
  return steps;
}

/** Cap the stored request summary so a long paste doesn't bloat the Plan node.
 *  280 chars is plenty for the semantic same-task comparison the GC pass runs. */
export function summariseRequest(userMessage: string): string {
  const t = userMessage.trim().replace(/\s+/g, ' ');
  return t.length > 280 ? `${t.slice(0, 280)}…` : t;
}

export interface MaterializeInput {
  /** Stable plan id for this turn (the orchestrator turn id). */
  planId: string;
  scope: string;
  userMessage: string;
  /** ISO timestamp; injected so the caller controls the clock. */
  createdAt: string;
  llm: Pick<LlmAccessor, 'complete'>;
  kg: KnowledgeGraph;
}

export interface MaterializeResult {
  planExternalId: string;
  stepCount: number;
  /** External ids of the persisted steps, in order — for in-turn progress
   *  tracking (E3). */
  stepExternalIds: string[];
  /** Per-step exit conditions, aligned 1:1 with {@link stepExternalIds}
   *  (undefined where the step declared none). Powers the opt-in E4 trigger
   *  (b) exit-condition check without a per-tool knowledge-graph read. */
  exitConditions: Array<string | undefined>;
}

/** Persist a parsed step list as a Plan + PlanStep DAG. Shared by the LLM
 *  materialiser ({@link materializePlan}) and the process-reuse materialiser
 *  ({@link materializePlanFromSteps}) so both write identical graph shapes;
 *  only `createdBy`/`strategy` provenance differs. */
async function persistPlan(
  input: Pick<
    MaterializeInput,
    'planId' | 'scope' | 'userMessage' | 'createdAt' | 'kg'
  >,
  steps: ParsedStep[],
  provenance: { createdBy: 'gate' | 'process'; strategy?: string },
): Promise<MaterializeResult | null> {
  if (steps.length === 0) return null;

  const { planExternalId } = await input.kg.ingestPlan({
    planId: input.planId,
    scope: input.scope,
    createdBy: provenance.createdBy,
    ...(provenance.strategy ? { strategy: provenance.strategy } : {}),
    createdAt: input.createdAt,
    // #237 (plan GC) — stash a capped copy of the request so the GC pass can
    // judge whether a later plan in this scope is the same task re-planned.
    requestSummary: summariseRequest(input.userMessage),
  });

  // Stable per-step ids so DEPENDS_ON references resolve and re-runs are
  // idempotent.
  const stepIds = steps.map((_, i) => `${input.planId}-s${String(i)}`);
  const stepExternalIds: string[] = [];
  const exitConditions: Array<string | undefined> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const dependsOnStepIds = step.dependsOn
      .map((idx) => stepIds[idx])
      .filter((id): id is string => id !== undefined && id !== stepIds[i]);
    const { stepExternalId } = await input.kg.upsertPlanStep({
      stepId: stepIds[i]!,
      planId: input.planId,
      scope: input.scope,
      goal: step.goal,
      order: i,
      status: 'pending',
      ...(step.exitCondition ? { exitCondition: step.exitCondition } : {}),
      ...(dependsOnStepIds.length > 0 ? { dependsOnStepIds } : {}),
    });
    stepExternalIds.push(stepExternalId);
    exitConditions.push(step.exitCondition);
  }

  return { planExternalId, stepCount: steps.length, stepExternalIds, exitConditions };
}

/** Materialise + persist a plan. Returns null when the model produced no
 *  usable steps (the gate said "plan" but decomposition yielded nothing). */
export async function materializePlan(
  input: MaterializeInput,
): Promise<MaterializeResult | null> {
  const res = await input.llm.complete({
    model: PLAN_MODEL,
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: input.userMessage.trim() }],
    maxTokens: 1024,
    temperature: 0,
  });
  return persistPlan(input, parsePlanSteps(res.text), { createdBy: 'gate' });
}

export interface MaterializeFromStepsInput
  extends Omit<MaterializeInput, 'llm'> {
  /** Ordered workflow steps from a reused {@link ProcessRecord}. Flat strings
   *  (Phase-7 process shape) → sequential plan steps, no DAG dependencies. */
  steps: readonly string[];
  /** Title of the source process — stored on the plan as `strategy` so the UI
   *  and GC can see the plan was reused, not freshly thought. */
  processTitle: string;
}

/**
 * Materialise a plan from a reused stored process — NO LLM call. The agent
 * learned this workflow once (`write_process`); reusing its steps here is what
 * stops every plan-worthy turn from re-deriving the same DAG via Haiku. Data
 * is still fetched fresh at execution time — the plan only fixes the *steps*,
 * never their results. Returns null on an empty/blank step list.
 */
export async function materializePlanFromSteps(
  input: MaterializeFromStepsInput,
): Promise<MaterializeResult | null> {
  const steps: ParsedStep[] = input.steps
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((goal) => ({ goal, dependsOn: [] }));
  return persistPlan(input, steps, {
    createdBy: 'process',
    strategy: `Reused stored process: ${input.processTitle}`,
  });
}
