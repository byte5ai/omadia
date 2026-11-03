import type { DecisionBatchResult, DecisionModelService, DecisionQuestion } from '@omadia/plugin-api';
import { normalizeDecisionBatch } from '@omadia/plugin-api';

import {
  DECISION_TIMEOUT_MS,
  DIRECT_PLAN_MIN_CONFIDENCE,
  gateInstruction,
  sourceOptions,
  type DecisionStepSink,
  type GateSignal,
} from './decisionRouter.js';
import type { FastPathToolSpec } from './fastPath.js';
import { planToFetch, type LearnedPlan } from './learnedPlanStore.js';
import { containsPlaceholder } from './literalStripping.js';
import { ROUTER_MIN_CONFIDENCE, type DecisionTrace, type RouteOutcome, type RouterIntent } from './router.js';
import { fillSlots, fixedVocabulary, isFillable, planSlots, slotCandidates } from './slotCandidates.js';
import { validatePlannedQuery, type PlannedQuery } from './triage.js';

/**
 * The TURN GATE — every fast-path decision of a turn in ONE decision-model
 * request (`decisionModel@1` `decideAll`). A provider like Jev evaluates the
 * questions of a request in parallel, so the whole gate costs one round trip
 * (~150–300 ms) instead of a chain of calls:
 *
 *   data     yes/no  — do the rows of ONE read call answer the turn?
 *   complex  yes/no  — for the agent: simple or complex route
 *   plan     yes/no  — does the agent need an explicit multi-step plan?
 *                      (the plan-runner takes it instead of its own gate)
 *   source   choice  — which offered tool (plugin, API, MCP)
 *   direct   choice  — which learned plan answers it as stored, if any
 *   slot_*   choice  — per placeholder of a candidate plan: which span of
 *                      the turn is its value (P2, slot filling)
 *
 * The direct and slot questions are asked SPECULATIVELY — before the source
 * is known — so nothing chains. Yes/no answers are calibrated probabilities;
 * a probability between the two bars decides nothing and the LLM router takes
 * the turn. Any failure returns undefined (the caller falls back).
 */

export const TURN_GATE_TASK = 'fast-path.turn-gate';
/** `data` probability at/above which the turn is a data turn. */
export const DATA_YES = 0.6;
/** `data` probability at/below which the turn needs a model. */
export const DATA_NO = 0.4;
/** `plan` probability bars for the plan-runner hint. */
export const PLAN_YES = 0.6;
export const PLAN_NO = 0.4;
/** A `none` source at/above this confidence makes the turn a model turn. */
export const NO_SOURCE_MIN = 0.8;
/** Below this a slot value is not taken. */
export const SLOT_MIN_CONFIDENCE = 0.85;

const PLAN_PREFIX = 'plan:';
const PLAN_NEW = 'plan_new';
const SLOT_NONE = 'none';
/** the source question's "no source fits" option (decisionRouter.ts) */
const SOURCE_NONE = 'none';

export const DATA_QUESTION =
  'Is the answer to the USER TURN exactly the rows of ONE read call to a data source — a lookup or list, ' +
  'optionally counted, totalled, or the top N rows by one of their own columns — or a follow-up of the PREVIOUS ' +
  'QUERY that only changes values? No for explanations, advice, opinions, writes or changes, comparisons, ' +
  'analysis, totals or rankings PER GROUP, several queries, greetings and chit-chat.';
export const COMPLEX_QUESTION =
  'Does answering the USER TURN need explanation, analysis, comparison, writing, several steps or several ' +
  'sources — more than a greeting, a short confirmation or a one-step answer?';
export const PLAN_QUESTION =
  'Does answering the USER TURN need an explicit multi-step plan — several distinct sub-goals or tool steps ' +
  'that must be done in sequence?';
export const DIRECT_QUESTION =
  'Which stored question asks EXACTLY what the USER TURN asks? Placeholders like {{text_1}} stand for a name or ' +
  'value the turn names. Pick plan_new when the turn adds or changes anything else — a number, a date or period, ' +
  'a status, a limit, a sort, or a different subject.';

export interface TurnGateResult {
  outcome: RouteOutcome;
  /** a learned plan picked to run without the planner (slots filled) */
  direct?: PlannedQuery;
  /** the plan-runner hint of a model turn */
  planHint?: 'plan' | 'direct';
}

/** A direct-plan candidate: active, examples, no top-N, fillable slots. */
export function isGateCandidate(plan: LearnedPlan): boolean {
  return plan.active && plan.take === undefined && plan.examples.length > 0 && isFillable(planToFetch(plan));
}

function slotQuestionId(planIdx: number, slotIdx: number): string {
  return `slot_${planIdx}_${slotIdx}`;
}

/** The batch questions of a turn. */
export function turnGateQuestions(opts: {
  tools: readonly FastPathToolSpec[];
  intents?: readonly RouterIntent[];
  candidates: readonly LearnedPlan[];
  message: string;
  /** the canvas widens the data question (decisionRouter.ts CANVAS_GATE_CLAUSE) */
  channel?: string;
}): { questions: Record<string, DecisionQuestion>; slotOptions: Map<string, string[]> } {
  const questions: Record<string, DecisionQuestion> = {
    data: { kind: 'yesno', instruction: gateInstruction(DATA_QUESTION, opts.channel ?? '') },
    complex: { kind: 'yesno', instruction: COMPLEX_QUESTION },
    plan: { kind: 'yesno', instruction: PLAN_QUESTION },
  };
  const slotOptions = new Map<string, string[]>();
  if (opts.tools.length > 0) {
    questions['source'] = {
      kind: 'choice',
      instruction: 'Which ONE data source returns, in a single read call, the rows that answer the USER TURN?',
      options: sourceOptions(opts.tools, opts.intents),
    };
  }
  if (opts.candidates.length > 0) {
    questions['direct'] = {
      kind: 'choice',
      instruction: DIRECT_QUESTION,
      options: [
        ...opts.candidates.map((p) => ({
          id: `${PLAN_PREFIX}${p.id}`,
          description: p.examples.slice(0, 3).map((q) => `"${q}"`).join('; '),
        })),
        { id: PLAN_NEW, description: 'none of these exactly — the turn needs its own query' },
      ],
    };
    opts.candidates.forEach((p, i) => {
      const slots = planSlots(planToFetch(p));
      if (slots.length === 0) return;
      const values = slotCandidates(opts.message, fixedVocabulary(p.examples));
      slots.forEach((slot, j) => {
        const id = slotQuestionId(i, j);
        slotOptions.set(id, values);
        questions[id] = {
          kind: 'choice',
          instruction: `In the stored question "${p.examples[0] ?? ''}", which part of the USER TURN is the value of ${slot}?`,
          options: [
            ...values.map((v, k) => ({ id: `c${k}`, description: v })),
            { id: SLOT_NONE, description: 'the turn names no such value' },
          ],
        };
      });
    });
  }
  return { questions, slotOptions };
}

/** Ask the batch, HARD-bounded by the decision deadline; undefined on any
 *  error or timeout (logged). */
async function askBatch(
  decide: DecisionModelService,
  input: string,
  questions: Record<string, DecisionQuestion>,
  log: (message: string) => void,
): Promise<DecisionBatchResult | undefined> {
  if (!decide.decideAll) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${DECISION_TIMEOUT_MS} ms`)), DECISION_TIMEOUT_MS);
  });
  try {
    const raw = await Promise.race([
      decide.decideAll({ task: TURN_GATE_TASK, input, questions, signal: AbortSignal.timeout(DECISION_TIMEOUT_MS) }),
      deadline,
    ]);
    return normalizeDecisionBatch({ questions }, raw);
  } catch (err) {
    log(`[fast-path] decision ${TURN_GATE_TASK} provider=${decide.provider} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function yes(result: DecisionBatchResult, id: string): number | undefined {
  const a = result.answers[id];
  return a?.kind === 'yesno' ? a.probability : undefined;
}

function picked(result: DecisionBatchResult, id: string): { choice: string; confidence: number } | undefined {
  const a = result.answers[id];
  return a?.kind === 'choice' ? { choice: a.choice, confidence: a.confidence } : undefined;
}

/** The chosen learned plan with every slot filled, validated — or undefined. */
function directPlan(opts: {
  result: DecisionBatchResult;
  tool: string;
  candidates: readonly LearnedPlan[];
  slotOptions: ReadonlyMap<string, string[]>;
  restore: (text: string) => string;
  allowedTools: ReadonlySet<string>;
  question: string;
}): { plan: PlannedQuery; slots: number } | undefined {
  const pick = picked(opts.result, 'direct');
  if (!pick || pick.choice === PLAN_NEW || pick.confidence < DIRECT_PLAN_MIN_CONFIDENCE) return undefined;
  const idx = opts.candidates.findIndex((p) => `${PLAN_PREFIX}${p.id}` === pick.choice);
  const plan = opts.candidates[idx];
  if (!plan || plan.tool !== opts.tool) return undefined;
  const fetch = planToFetch(plan);
  const slots = planSlots(fetch);
  const values = new Map<string, string>();
  for (const [j, slot] of slots.entries()) {
    const id = slotQuestionId(idx, j);
    const answer = picked(opts.result, id);
    const options = opts.slotOptions.get(id) ?? [];
    if (!answer || answer.choice === SLOT_NONE || answer.confidence < SLOT_MIN_CONFIDENCE) return undefined;
    const span = options[Number(answer.choice.slice(1))];
    if (span === undefined) return undefined;
    values.set(slot, opts.restore(span));
  }
  const filled = slots.length > 0 ? fillSlots(fetch, values) : fetch;
  if (!filled || containsPlaceholder(filled)) return undefined;
  const validated = validatePlannedQuery({ fetch: filled }, opts.allowedTools, { question: opts.question });
  return validated.ok ? { plan: validated.plan, slots: slots.length } : undefined;
}

/** Decide the turn in one request. undefined → the caller's fallback. */
export async function turnGateByDecision(opts: {
  decide: DecisionModelService;
  channel: string;
  /** the turn message — already masked when a shield runs */
  message: string;
  /** the RAW user question — only for the default summary's language */
  question: string;
  tools: readonly FastPathToolSpec[];
  intents?: readonly RouterIntent[];
  /** learned plans eligible to run without the planner (caller-checked
   *  turn eligibility; empty → no direct/slot questions) */
  candidates: readonly LearnedPlan[];
  allowedTools: ReadonlySet<string>;
  /** the privacy run's restore — a picked span back to the real value */
  restore: (text: string) => string;
  /** told every answer of the batch (`fast-path.turn-gate.<question>`) */
  onStep?: DecisionStepSink;
  /** told the gate's verdict as soon as the batch answered */
  onGate?: (gate: GateSignal) => void;
  log: (message: string) => void;
}): Promise<TurnGateResult | undefined> {
  if (!opts.decide.decideAll) return undefined;
  const t0 = Date.now();
  const candidates = opts.candidates.filter(isGateCandidate);
  const { questions, slotOptions } = turnGateQuestions({ ...opts, candidates });
  const result = await askBatch(opts.decide, opts.message, questions, opts.log);
  if (!result) {
    opts.onGate?.({ verdict: 'none' });
    return undefined;
  }
  const ms = Date.now() - t0;
  // one step per answer — the question id, never a span or an option text
  for (const [id, a] of Object.entries(result.answers)) {
    const task = `${TURN_GATE_TASK}.${id.startsWith('slot_') ? 'slot' : id}`;
    opts.onStep?.(
      a.kind === 'yesno'
        ? { task, choice: a.probability >= 0.5 ? 'yes' : 'no', confidence: Math.max(a.probability, 1 - a.probability), ms }
        : { task, choice: id.startsWith('slot_') ? 'value' : a.choice, confidence: a.confidence, ms },
    );
  }
  const pData = yes(result, 'data');
  const pComplex = yes(result, 'complex');
  const pPlan = yes(result, 'plan');
  const source = picked(result, 'source');
  opts.log(
    `[fast-path] decision turn-gate channel=${opts.channel} provider=${opts.decide.provider} ` +
      `data=${pData?.toFixed(2) ?? '-'} complex=${pComplex?.toFixed(2) ?? '-'} plan=${pPlan?.toFixed(2) ?? '-'} ` +
      `source=${source ? `${source.choice}:${source.confidence.toFixed(2)}` : '-'} questions=${Object.keys(questions).length} ms=${ms}`,
  );
  if (pData === undefined) {
    opts.onGate?.({ verdict: 'none' });
    return undefined;
  }
  const trace = (over: Pick<DecisionTrace, 'verdict' | 'confidence'> & Partial<DecisionTrace>): DecisionTrace => ({
    provider: opts.decide.provider,
    ...(result.model !== undefined ? { model: result.model } : {}),
    ms,
    ...over,
  });

  // "no offered source answers this in one read call", said with
  // confidence, is a model verdict too — whatever the data probability
  // (live: "Was steht in Confluence zu …" came back data=0.57 between the
  // bars with source=none:1.00 — a sub-agent's question, not a query's)
  const noSource = source !== undefined && source.choice === SOURCE_NONE && source.confidence >= NO_SOURCE_MIN;
  if (pData <= DATA_NO || noSource) {
    const route = pComplex === undefined || pComplex >= 0.5 ? 'complex' : 'simple';
    const confidence = pData <= DATA_NO ? 1 - pData : (source?.confidence ?? 0);
    opts.onGate?.({ verdict: 'model', route, confidence });
    const planHint = pPlan === undefined ? undefined : pPlan >= PLAN_YES ? 'plan' : pPlan <= PLAN_NO ? 'direct' : undefined;
    return {
      outcome: {
        kind: 'agent',
        reason: pData <= DATA_NO ? `agent:${route}` : `agent:${route}:no-source`,
        route,
        ms,
        decision: trace({ verdict: 'model', route, confidence }),
      },
      ...(planHint ? { planHint } : {}),
    };
  }
  if (pData < DATA_YES) {
    opts.onGate?.({ verdict: 'none', confidence: pData });
    return undefined;
  }
  opts.onGate?.({ verdict: 'data', confidence: pData });
  if (!source || source.confidence < ROUTER_MIN_CONFIDENCE) return undefined;
  if (!source.choice.startsWith('tool:')) {
    // an unsure "none" — no route either; the agent's own router decides
    return { outcome: { kind: 'agent', reason: 'decision-no-source', ms, decision: trace({ verdict: 'data', confidence: pData }) } };
  }
  const tool = source.choice.slice('tool:'.length);
  const confidence = pData * source.confidence;
  const direct = directPlan({ result, tool, candidates, slotOptions, restore: opts.restore, allowedTools: opts.allowedTools, question: opts.question });
  if (direct) {
    opts.log(`[fast-path] decision direct-plan channel=${opts.channel} tool=${tool} slots=${direct.slots}`);
  }
  return {
    outcome: { kind: 'plan', tool, confidence, ms, decision: trace({ verdict: 'data', tool, confidence, ...(direct ? { direct: true as const } : {}) }) },
    ...(direct ? { direct: direct.plan } : {}),
  };
}
