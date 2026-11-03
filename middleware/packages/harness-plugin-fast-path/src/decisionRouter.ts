import type { DecisionChoiceResult, DecisionModelService, DecisionOption } from '@omadia/plugin-api';
import { normalizeDecisionChoice } from '@omadia/plugin-api';

import { toolPurpose, type FastPathToolSpec } from './fastPath.js';
import { planToFetch, type LearnedPlan } from './learnedPlanStore.js';
import { containsPlaceholder } from './literalStripping.js';
import {
  ROUTER_MIN_CONFIDENCE,
  type DecisionStep,
  type DecisionTrace,
  type RouteOutcome,
  type RouterIntent,
} from './router.js';
import type { TriageRoute } from './triage.js';
import { validatePlannedQuery, type PlannedQuery } from './triage.js';

/**
 * Fast-path routing on a typed DECISION MODEL (`decisionModel@1`, e.g.
 * TypeSafe Jev) instead of a forced-tool LLM call.
 *
 * The router's job is a closed choice — deterministic with tool X, or the
 * agent (simple/complex) — so a decision model answers it in milliseconds
 * with a calibrated confidence. Three decisions run on it:
 *
 *   1. GATE — model yes/no, BEFORE any triage model call: does the turn
 *      need a language model (`model_simple` / `model_complex` → the agent,
 *      with its route hint) or is it answered by data (`data`)? A "yes"
 *      costs ZERO fast-path LLM calls: no router, no planner.
 *   2. SOURCE — only after "no": one option per offered tool — any data
 *      source the agent has (plugin tool, API-backed tool, MCP tool).
 *      Replaces router.ts's LLM call; the planner is no longer started
 *      speculatively.
 *   3. DIRECT PLAN: after a deterministic route, one option per ACTIVE
 *      learned plan of that tool that runs as stored (no placeholder, no
 *      top-N) plus `plan_new`. A confident pick runs that plan with no
 *      planner call — the zero-LLM path for paraphrases the answer cache
 *      (exact shapes only) cannot match.
 *
 * Every failure returns `undefined` and the caller takes its LLM path, so
 * a decision model can only remove model calls, never answers. The input is
 * the turn message AFTER the privacy run — never the raw question.
 */

export const GATE_TASK = 'fast-path.gate';
export const SOURCE_TASK = 'fast-path.source';
export const DIRECT_PLAN_TASK = 'fast-path.direct-plan';
/** Below this a direct plan is not run (the planner plans instead). A wrong
 *  replay is worse than one planner call. */
export const DIRECT_PLAN_MIN_CONFIDENCE = 0.85;
/** Decision deadline; past it the LLM path takes over. */
export const DECISION_TIMEOUT_MS = 2000;
/** Learned plans offered per direct-plan decision. */
export const MAX_DIRECT_PLANS = 8;
/** Example questions shown per option. */
const MAX_OPTION_EXAMPLES = 3;

const MODEL_SIMPLE = 'model_simple';
const MODEL_COMPLEX = 'model_complex';
const DATA = 'data';
const TOOL_PREFIX = 'tool:';
const PLAN_PREFIX = 'plan:';
const PLAN_NEW = 'plan_new';

export const GATE_INSTRUCTION =
  'Does answering the USER TURN need a language model? "data" ONLY when the answer IS the rows of exactly ONE ' +
  'read call to a data source — a lookup or list, optionally counted, totalled or the top N rows by one of their ' +
  'own columns — or a follow-up of the PREVIOUS QUERY that only changes values. Totals, counts or rankings PER ' +
  'GROUP, comparisons, analysis, explanations, writes, several calls or anything unclear need a model.';

export const GATE_OPTIONS: readonly DecisionOption[] = [
  { id: DATA, description: 'no model: the rows of ONE read call to a data source answer it' },
  { id: MODEL_SIMPLE, description: 'model, simple: greeting, chit-chat, a short confirmation, a one-step question without data' },
  {
    id: MODEL_COMPLEX,
    description: 'model, complex: explanation, advice, writes, several calls, per-group totals or rankings, analysis, or unclear',
  },
];

export const SOURCE_INSTRUCTION =
  'Pick the ONE data source whose single read call returns the rows that answer the USER TURN. A follow-up of the ' +
  'PREVIOUS QUERY keeps its source. If no source fits, pick none.';
const SOURCE_NONE = 'none';

export const DIRECT_PLAN_INSTRUCTION =
  'Pick the stored query that answers the USER TURN EXACTLY as stored. If the turn names anything a stored ' +
  'question does not — a name, a number, a date or period, a place, a status, a limit or a different sort — ' +
  'pick plan_new.';

/** The source options: every offered tool, then `none`. */
export function sourceOptions(tools: readonly FastPathToolSpec[], intents: readonly RouterIntent[] = []): DecisionOption[] {
  const toolOptions = tools.map((t) => {
    const examples = intents
      .filter((i) => i.tool === t.name && i.question.length > 0)
      .slice(0, MAX_OPTION_EXAMPLES)
      .map((i) => `"${i.question}"`);
    return {
      id: `${TOOL_PREFIX}${t.name}`,
      description: `ONE read query with ${t.name}: ${toolPurpose(t)}` + (examples.length > 0 ? ` e.g. ${examples.join('; ')}` : ''),
    };
  });
  return [...toolOptions, { id: SOURCE_NONE, description: 'no listed source answers it in one read call' }];
}

/** Told every decision the model answered (also an unsure one), in call
 *  order — what a channel shows as "what ran on the decision model". */
export type DecisionStepSink = (step: DecisionStep) => void;

/** What the gate said, told as soon as it answered — before the source or
 *  the planner. `none`: no usable gate (no model, failure, below the bar). */
export interface GateSignal {
  verdict: 'data' | 'model' | 'none';
  route?: TriageRoute;
  confidence?: number;
}

/** Ask the decision model, HARD-bounded by {@link DECISION_TIMEOUT_MS} (the
 *  abort signal is a courtesy a provider may ignore — the race is not);
 *  undefined on any error, timeout or malformed answer (logged). Never
 *  throws. A valid answer is reported to `onStep`. */
export async function chooseDecision(
  decide: DecisionModelService,
  req: { task: string; instruction: string; input: string; options: readonly DecisionOption[] },
  log: (message: string) => void,
  onStep?: DecisionStepSink,
): Promise<DecisionChoiceResult | undefined> {
  const t0 = Date.now();
  const result = await chooseBounded(decide, req, log);
  if (result) onStep?.({ task: req.task, choice: result.choice, confidence: result.confidence, ms: Date.now() - t0 });
  return result;
}

async function chooseBounded(
  decide: DecisionModelService,
  req: { task: string; instruction: string; input: string; options: readonly DecisionOption[] },
  log: (message: string) => void,
): Promise<DecisionChoiceResult | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${DECISION_TIMEOUT_MS} ms`)), DECISION_TIMEOUT_MS);
  });
  try {
    const raw = await Promise.race([decide.choose({ ...req, signal: AbortSignal.timeout(DECISION_TIMEOUT_MS) }), deadline]);
    const result = normalizeDecisionChoice(req, raw);
    if (!result) log(`[fast-path] decision ${req.task} provider=${decide.provider} invalid answer`);
    return result;
  } catch (err) {
    log(`[fast-path] decision ${req.task} provider=${decide.provider} failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Gate (model yes/no), then the source. undefined → take the LLM router. */
export async function routeByDecision(opts: {
  decide: DecisionModelService;
  channel: string;
  /** the turn message — already masked when a shield runs */
  message: string;
  tools: readonly FastPathToolSpec[];
  intents?: readonly RouterIntent[];
  log: (message: string) => void;
  onStep?: DecisionStepSink;
  /** told the gate's verdict as soon as it answered */
  onGate?: (gate: GateSignal) => void;
}): Promise<RouteOutcome | undefined> {
  const t0 = Date.now();
  const provider = opts.decide.provider;
  const steps: DecisionStep[] = [];
  const onStep: DecisionStepSink = (step) => {
    steps.push(step);
    opts.onStep?.(step);
  };
  const gate = await chooseDecision(
    opts.decide,
    { task: GATE_TASK, instruction: GATE_INSTRUCTION, input: opts.message, options: GATE_OPTIONS },
    opts.log,
    onStep,
  );
  if (!gate) {
    opts.onGate?.({ verdict: 'none' });
    return undefined;
  }
  opts.log(
    `[fast-path] decision gate channel=${opts.channel} provider=${provider} choice=${gate.choice} ` +
      `conf=${gate.confidence.toFixed(2)} ms=${Date.now() - t0}`,
  );
  // an unsure gate decides nothing: the LLM router takes the turn
  if (gate.confidence < ROUTER_MIN_CONFIDENCE) {
    opts.onGate?.({ verdict: 'none', confidence: gate.confidence });
    return undefined;
  }
  const trace = (over: Partial<DecisionTrace> & Pick<DecisionTrace, 'verdict' | 'confidence'>): DecisionTrace => ({
    provider,
    ...(gate.model !== undefined ? { model: gate.model } : {}),
    ms: Date.now() - t0,
    steps: [...steps],
    ...over,
  });
  if (gate.choice === MODEL_SIMPLE || gate.choice === MODEL_COMPLEX) {
    const route = gate.choice === MODEL_SIMPLE ? 'simple' : 'complex';
    opts.onGate?.({ verdict: 'model', route, confidence: gate.confidence });
    return {
      kind: 'agent',
      reason: `agent:${route}`,
      route,
      ms: Date.now() - t0,
      decision: trace({ verdict: 'model', route, confidence: gate.confidence }),
    };
  }
  opts.onGate?.({ verdict: 'data', confidence: gate.confidence });
  const source = await chooseDecision(
    opts.decide,
    {
      task: SOURCE_TASK,
      instruction: SOURCE_INSTRUCTION,
      input: opts.message,
      options: sourceOptions(opts.tools, opts.intents),
    },
    opts.log,
    onStep,
  );
  const ms = Date.now() - t0;
  if (!source) return undefined;
  opts.log(
    `[fast-path] decision source channel=${opts.channel} provider=${provider} choice=${source.choice} ` +
      `conf=${source.confidence.toFixed(2)} ms=${ms}`,
  );
  if (source.confidence < ROUTER_MIN_CONFIDENCE) return undefined;
  if (source.choice === SOURCE_NONE) {
    return { kind: 'agent', reason: 'decision-no-source', ms, decision: trace({ verdict: 'data', confidence: gate.confidence }) };
  }
  // the turn's confidence: both decisions must hold
  const tool = source.choice.slice(TOOL_PREFIX.length);
  const confidence = gate.confidence * source.confidence;
  return { kind: 'plan', tool, confidence, ms, decision: trace({ verdict: 'data', tool, confidence }) };
}

/** A learned plan that can run exactly as stored: active, no placeholder
 *  anywhere, no top-N (the N is the user's). */
export function isDirectPlan(plan: LearnedPlan): boolean {
  return plan.active && plan.take === undefined && !containsPlaceholder(planToFetch(plan)) && plan.examples.length > 0;
}

/**
 * Pick a learned plan of `tool` to run without the planner. undefined →
 * plan with the LLM planner. Only called for a deterministic route of a
 * turn without a previous query whose message the privacy run left
 * unchanged (no detected personal value) — the caller checks.
 */
export async function directPlanByDecision(opts: {
  decide: DecisionModelService;
  channel: string;
  message: string;
  /** the RAW user question — only for the default summary's language */
  question: string;
  tool: string;
  plans: readonly LearnedPlan[];
  allowedTools: ReadonlySet<string>;
  log: (message: string) => void;
  onStep?: DecisionStepSink;
}): Promise<PlannedQuery | undefined> {
  if (/\d/.test(opts.question)) return undefined; // a number is a value the plan may not have
  const candidates = opts.plans.filter((p) => p.tool === opts.tool && isDirectPlan(p)).slice(0, MAX_DIRECT_PLANS);
  if (candidates.length === 0) return undefined;
  const options: DecisionOption[] = [
    ...candidates.map((p) => ({
      id: `${PLAN_PREFIX}${p.id}`,
      description: p.examples.slice(0, MAX_OPTION_EXAMPLES).map((q) => `"${q}"`).join('; '),
    })),
    { id: PLAN_NEW, description: 'none of these exactly — the turn needs its own query' },
  ];
  const t0 = Date.now();
  const result = await chooseDecision(
    opts.decide,
    { task: DIRECT_PLAN_TASK, instruction: DIRECT_PLAN_INSTRUCTION, input: opts.message, options },
    opts.log,
    opts.onStep,
  );
  if (!result) return undefined;
  opts.log(
    `[fast-path] decision direct-plan channel=${opts.channel} choice=${result.choice} ` +
      `conf=${result.confidence.toFixed(2)} ms=${Date.now() - t0}`,
  );
  if (result.choice === PLAN_NEW || result.confidence < DIRECT_PLAN_MIN_CONFIDENCE) return undefined;
  const plan = candidates.find((p) => `${PLAN_PREFIX}${p.id}` === result.choice);
  if (!plan) return undefined;
  const validated = validatePlannedQuery({ fetch: planToFetch(plan) }, opts.allowedTools, { question: opts.question });
  return validated.ok ? validated.plan : undefined;
}
