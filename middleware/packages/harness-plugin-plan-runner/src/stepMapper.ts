import {
  PLAN_STEP_ANSWER_EVIDENCE,
  type KnowledgeGraph,
  type LlmAccessor,
} from '@omadia/plugin-api';

import { NOT_REACHED_SUMMARY } from './progress.js';
import { REPLAN_MODEL } from './replanner.js';

/**
 * #1502 follow-up, option C — one Haiku pass at turn end maps the turn's whole
 * tool trace to the plan's steps, for the persisted record and plan recall.
 *
 * The live card keeps the sequential heuristic (`progress.ts`): the i-th work
 * call completes the i-th step. That heuristic credits the wrong step when a
 * call does not serve its step, and under-credits when one call covers two
 * steps. This pass corrects the stored statuses after the turn; when the judge
 * fails or answers something unusable, the heuristic result stays as it is
 * (same fallback idea as `exitConditionMet`).
 */

/** One successful work call of the turn, as the plugin saw it. */
export interface TraceEntry {
  readonly toolName: string;
  readonly result: string;
}

/** The judge's verdict for one step (0-based indices). */
export interface StepMapping {
  /** Trace entries that did this step's work. */
  readonly calls: readonly number[];
  /** True when the turn's answer itself completed the step (no tool needed). */
  readonly answer: boolean;
}

/** Calls beyond this are not shown to the judge; the turn is rare and the
 *  mapping of the first ones still corrects the record. */
const MAX_TRACE = 40;
/** What the plugin keeps of a result: enough for the step's evidence
 *  (`evidenceFor` uses 200), never the whole payload. */
export const TRACE_RESULT_HEAD = 300;

const MAP_SYSTEM = [
  'You map the tool calls of one assistant turn to the steps of its plan.',
  'For every step, list the numbers of the calls that actually did that step\'s work.',
  'A call may serve several steps, and a step may need several calls.',
  'A call that does not serve a step must not be listed for it.',
  'Set "answer" to true only for a step the final answer itself completes',
  '(e.g. presenting or summarising results) and that needs no tool.',
  'A step neither a call nor the answer completed gets "calls": [] and "answer": false.',
  'Reply with JSON only, no prose:',
  '{"steps":[{"step":1,"calls":[1,2],"answer":false}, ...]}',
].join('\n');

function head(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Compact, labelled evidence string — the same shape the heuristic writes,
 *  so `isEvidencedPlanStepDone` and recall read both alike. */
export function evidenceFor(entry: TraceEntry): string {
  return `${entry.toolName}: ${head(entry.result, 200)}`;
}

/**
 * Tolerant parse of the judge's answer. Returns `undefined` — keep the
 * heuristic — on anything that is not a well-formed verdict for exactly the
 * given step count with in-range call numbers. Partial trust would mix two
 * mappings in one plan.
 */
export function parseStepMapping(
  raw: string,
  stepCount: number,
  callCount: number,
): StepMapping[] | undefined {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const steps = (data as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return undefined;
  const out: Array<StepMapping | undefined> = new Array<StepMapping | undefined>(stepCount).fill(
    undefined,
  );
  for (const item of steps) {
    if (typeof item !== 'object' || item === null) return undefined;
    const rec = item as Record<string, unknown>;
    const step = rec['step'];
    if (!Number.isInteger(step) || (step as number) < 1 || (step as number) > stepCount) {
      return undefined;
    }
    const callsRaw = rec['calls'] ?? [];
    if (!Array.isArray(callsRaw)) return undefined;
    const calls: number[] = [];
    for (const c of callsRaw) {
      if (!Number.isInteger(c) || (c as number) < 1 || (c as number) > callCount) return undefined;
      calls.push((c as number) - 1);
    }
    out[(step as number) - 1] = { calls, answer: rec['answer'] === true };
  }
  if (out.some((m) => m === undefined)) return undefined;
  return out as StepMapping[];
}

/**
 * Ask the judge. `undefined` on any failure — the caller keeps the heuristic.
 *
 * PRIVACY: the request carries the step goals, the tool NAMES in call order
 * and whether the turn answered — never a tool result and never the answer.
 * This call goes out through `ctx.llm` unmasked, a tool result can hold real
 * values whatever the shield posture, and the delivered answer carries the
 * values the Privacy Shield restored. The results stay local: they become the
 * steps' evidence (`evidenceFor`), as the in-turn heuristic already stores.
 */
export async function judgeStepMapping(
  input: {
    readonly goals: readonly string[];
    readonly trace: readonly TraceEntry[];
    /** Whether the turn ended with an answer. */
    readonly answered: boolean;
  },
  llm: Pick<LlmAccessor, 'complete'>,
): Promise<StepMapping[] | undefined> {
  const trace = input.trace.slice(0, MAX_TRACE);
  const content = [
    'Plan steps:',
    ...input.goals.map((g, i) => `${String(i + 1)}. ${g}`),
    '',
    'Tool calls (in order):',
    ...(trace.length > 0
      ? trace.map((t, i) => `${String(i + 1)}. ${t.toolName}`)
      : ['(none)']),
    '',
    input.answered
      ? 'The turn ended with an answer to the user.'
      : 'The turn ended without an answer.',
  ].join('\n');
  try {
    const res = await llm.complete({
      model: REPLAN_MODEL,
      system: MAP_SYSTEM,
      messages: [{ role: 'user', content }],
      maxTokens: 512,
      temperature: 0,
    });
    return parseStepMapping(res.text, input.goals.length, trace.length);
  } catch {
    return undefined;
  }
}

/**
 * Re-map the turn's closed steps and write the judge's verdict to the graph.
 * Only steps of the active chain that the heuristic closed (`done` /
 * `skipped`) are touched; a `failed` step keeps the replanner's verdict.
 * Returns how many steps changed, or `undefined` when the judge failed and the
 * heuristic record stands.
 */
export async function remapPlanSteps(
  input: {
    readonly planExternalId: string;
    readonly stepExternalIds: readonly string[];
    readonly trace: readonly TraceEntry[];
    readonly answered: boolean;
  },
  kg: KnowledgeGraph,
  llm: Pick<LlmAccessor, 'complete'>,
): Promise<number | undefined> {
  const nodes = await kg.getPlanSteps(input.planExternalId);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const steps = input.stepExternalIds
    .map((id) => byId.get(id))
    .filter((n): n is NonNullable<typeof n> => {
      const status = n?.props['status'];
      return status === 'done' || status === 'skipped';
    });
  if (steps.length === 0) return 0;
  const mapping = await judgeStepMapping(
    {
      goals: steps.map((s) => String(s.props['goal'] ?? '')),
      trace: input.trace,
      answered: input.answered,
    },
    llm,
  );
  if (mapping === undefined) return undefined;
  // The judge took a while: a later turn (resume, GC, replan) may have moved
  // a step meanwhile. Only a step still exactly as it was read is rewritten.
  const now = new Map((await kg.getPlanSteps(input.planExternalId)).map((n) => [n.id, n]));
  let changed = 0;
  for (let i = 0; i < steps.length; i++) {
    const node = steps[i]!;
    const m = mapping[i]!;
    const current = now.get(node.id);
    if (
      current === undefined ||
      current.props['status'] !== node.props['status'] ||
      current.props['resultSummary'] !== node.props['resultSummary']
    ) {
      continue;
    }
    const first = m.calls[0];
    const [status, resultSummary] =
      first !== undefined
        ? (['done', evidenceFor(input.trace[first]!)] as const)
        : m.answer
          ? (['done', PLAN_STEP_ANSWER_EVIDENCE] as const)
          : (['skipped', NOT_REACHED_SUMMARY] as const);
    if (node.props['status'] === status && node.props['resultSummary'] === resultSummary) continue;
    await kg.setPlanStepStatus(node.id, status, { resultSummary });
    changed += 1;
  }
  return changed;
}
