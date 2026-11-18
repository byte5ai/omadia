import type { DecisionModelService } from '@omadia/plugin-api';

import type { AnswerCache, CacheTicket } from './answerCache.js';
import {
  directPlanByDecision,
  routeByDecision,
  type DecisionStepSink,
  type GateSignal,
} from './decisionRouter.js';
import type { FastLlm, FastPathToolSpec } from './fastPath.js';
import { planToFetch, type LearnedPlan } from './learnedPlanStore.js';
import { planQuery } from './planner.js';
import { routeTurn, type DecisionStep, type DecisionTrace, type RouteOutcome, type RouterIntent } from './router.js';
import { planSlots } from './slotCandidates.js';
import { turnGateByDecision } from './turnGate.js';
import type { StoredTextPrivacyRun } from './storedTextPrivacy.js';
import type { PlannedQuery, PreviousQuery, TriageRoute } from './triage.js';

/**
 * One fast-path triage per turn, every channel: router ∥ speculative planner.
 *
 *   1. The user-derived part of the turn — the question and the session's
 *      previous fast-path query — is ONE turn message, masked ONCE through
 *      the per-turn privacy run. Everything fixed (rules, tool specs, the
 *      Odoo catalog, learned plans) rides in the calls' SYSTEM prompts and
 *      is never masked (live: masking the whole 2.4 KB planner prompt cost
 *      2.4 s of sidecar time).
 *   2. Router and planner start TOGETHER on the same masked message (on the
 *      canvas also concurrently with the skeleton composer, which the caller
 *      starts). The plan is used only when the router decides deterministic
 *      with enough confidence for the SAME tool; otherwise it is discarded.
 *   3. The plan's strings are restored through the same privacy run.
 *
 * The cost of speculation: an agent-routed turn also pays one planner call
 * (tokens, not latency — it is not awaited).
 *
 * 0. Answer cache (answerCache.ts) FIRST, before any masking: a turn whose
 *    question shape was already answered and verified gets its plan with
 *    ZERO model calls (nothing leaves the process). Any doubt → the steps
 *    above. Every plan carries a `cache` ticket the caller settles after
 *    executing it (hit → keep / store, miss → evict).
 *
 * With a decision model (`decisionModel@1`, decisionRouter.ts) step 2 is
 * SEQUENTIAL instead: the decision model routes in milliseconds, the
 * planner runs only after a deterministic route — and not at all when the
 * decision model picks a learned plan that runs as stored. Any decision
 * failure takes the LLM path above unchanged.
 *
 * `onGate` tells the caller the gate's verdict the moment it answered (the
 * canvas skips its skeleton composer on `data`), exactly once per triage —
 * `none` when no decision model gated the turn.
 */

export type TriageOutcome =
  | {
      kind: 'plan';
      plan: PlannedQuery;
      ms: number;
      cache?: CacheTicket;
      decision?: DecisionTrace;
      /** the turn message the decision model saw (masked when a shield
       *  runs) — for a follow-up decision on the same turn (canvas layout) */
      decisionInput?: string;
    }
  | {
      kind: 'agent';
      route?: TriageRoute;
      reason: string;
      ms: number;
      decision?: DecisionTrace;
      /** the decision model's plan-runner hint (turnGate.ts) */
      planHint?: 'plan' | 'direct';
    };

/** The user message router and planner share: user-derived text only. */
export function buildTurnMessage(opts: { question: string; previous?: PreviousQuery }): string {
  const lines: string[] = [];
  if (opts.previous) {
    lines.push(`PREVIOUS QUERY: user asked "${opts.previous.question}" → ${JSON.stringify(opts.previous.fetch)}`);
  }
  lines.push(`USER TURN: ${opts.question}`);
  return lines.join('\n');
}

export async function triageTurn(opts: {
  llm: FastLlm;
  model: string;
  channel: string;
  question: string;
  /** the offered tools — ONLY tools the answering agent itself has */
  tools: readonly FastPathToolSpec[];
  /** the top-K active learned plans of those tools */
  offered: readonly LearnedPlan[];
  allowedTools: ReadonlySet<string>;
  previous?: PreviousQuery;
  privacy?: StoredTextPrivacyRun;
  /** the zero-LLM answer cache — pass it only for a plain text turn whose
   *  `question` is the user's own text (not an action/target turn) */
  answerCache?: Pick<AnswerCache, 'load' | 'lookup'>;
  /** told the cache verdict as soon as the lookup ran (before router and
   *  planner) — the canvas builds its skeleton from a hit without waiting */
  onCacheLookup?: (hit: boolean) => void;
  /** the typed decision model — routes (and may pick a learned plan)
   *  instead of the LLM router; absent → LLM router ∥ planner */
  decide?: DecisionModelService;
  /** let the decision model run a learned plan without the planner */
  directPlans?: boolean;
  /** told the gate's verdict once, as soon as it is known */
  onGate?: (gate: GateSignal) => void;
  /** told every decision-model answer of the turn */
  onDecisionStep?: DecisionStepSink;
  log: (message: string) => void;
}): Promise<TriageOutcome> {
  let gateTold = false;
  const tellGate = (gate: GateSignal): void => {
    if (gateTold) return;
    gateTold = true;
    opts.onGate?.(gate);
  };
  try {
    return await triage(opts, tellGate);
  } finally {
    tellGate({ verdict: 'none' });
  }
}

async function triage(
  opts: Parameters<typeof triageTurn>[0],
  tellGate: (gate: GateSignal) => void,
): Promise<TriageOutcome> {
  const t0 = Date.now();
  const agent = (reason: string, route?: TriageRoute): TriageOutcome => ({
    kind: 'agent',
    reason,
    ms: Date.now() - t0,
    ...(route ? { route } : {}),
  });
  const previous = opts.previous !== undefined;
  if (opts.answerCache) {
    const cached = await lookupAnswerCache(opts.answerCache, { ...opts, previous }, t0);
    opts.onCacheLookup?.(cached !== undefined);
    if (cached) return cached;
  }
  const unmasked = buildTurnMessage(opts);
  let message = unmasked;
  if (opts.privacy) {
    const masked = await opts.privacy.mask(message);
    if (!masked.send) {
      opts.log(`[fast-path] triage skipped channel=${opts.channel} (privacy: ${masked.reason})`);
      return agent('privacy-refused');
    }
    message = masked.text;
  }
  const privacy = opts.privacy;
  const base = { llm: opts.llm, model: opts.model, channel: opts.channel, message, tools: opts.tools, log: opts.log };
  const intents = opts.offered.map((p) => ({ question: p.examples[0] ?? '', tool: p.tool }));
  // the masked turn message rides on a plan for follow-up decisions
  const decisionInput = opts.decide ? { decisionInput: message } : {};
  if (opts.decide) {
    const steps: DecisionStep[] = [];
    const onStep: DecisionStepSink = (step) => {
      steps.push(step);
      opts.onDecisionStep?.(step);
    };
    const decided = await decideTurn({
      ...opts,
      decide: opts.decide,
      message,
      unmasked,
      previous,
      intents,
      onStep,
      onGate: tellGate,
    });
    const routed = decided?.outcome;
    const decision = routed?.decision;
    // the trace lists every answer of the turn, the direct-plan pick included
    const traced = (out: TriageOutcome): TriageOutcome => (decision ? { ...out, decision: { ...decision, steps: [...steps] } } : out);
    if (routed?.kind === 'agent') {
      const out = traced(agent(routed.reason, routed.route));
      return decided?.planHint && out.kind === 'agent' ? { ...out, planHint: decided.planHint } : out;
    }
    if (routed?.kind === 'plan') {
      if (!opts.tools.some((t) => t.name === routed.tool)) return traced(agent('router-tool-not-offered'));
      const ticket = opts.answerCache ? { cache: { source: 'llm' as const, question: opts.question, previous } } : {};
      if (decided?.direct) {
        return traced({ kind: 'plan', plan: decided.direct, ms: Date.now() - t0, ...ticket, ...decisionInput });
      }
      const planned = await planQuery({
        ...base,
        tools: opts.tools.filter((t) => t.name === routed.tool),
        question: opts.question,
        allowedTools: opts.allowedTools,
        examples: opts.offered.filter((p) => p.tool === routed.tool),
        ...(privacy ? { restore: (text: string) => privacy.restore(text) } : {}),
      });
      if (!planned.ok) return traced(agent(planned.reason));
      if (planned.plan.fetch.tool !== routed.tool) return traced(agent('planner-tool-mismatch'));
      return traced({ kind: 'plan', plan: planned.plan, ms: Date.now() - t0, ...ticket, ...decisionInput });
    }
    // no decision → the LLM router below
  }
  // speculative: started BEFORE the router answers; never throws
  const planning = planQuery({
    ...base,
    question: opts.question,
    allowedTools: opts.allowedTools,
    examples: opts.offered,
    ...(privacy ? { restore: (text: string) => privacy.restore(text) } : {}),
  });
  const route = await routeTurn({ ...base, intents });
  if (route.kind === 'agent') {
    opts.log(`[fast-path] planner discarded (route=${route.reason})`);
    return agent(route.reason, route.route);
  }
  const planned = await planning;
  if (!planned.ok) return agent(planned.reason);
  if (planned.plan.fetch.tool !== route.tool) {
    opts.log(`[fast-path] planner discarded (route=${route.tool}, plan=${planned.plan.fetch.tool})`);
    return agent('planner-tool-mismatch');
  }
  return {
    kind: 'plan',
    plan: planned.plan,
    ms: Date.now() - t0,
    ...decisionInput,
    ...(opts.answerCache ? { cache: { source: 'llm' as const, question: opts.question, previous } } : {}),
  };
}

/** The cached plan of this turn (offered ∩ allowed tools only), else
 *  undefined after logging why not. Never throws. */
async function lookupAnswerCache(
  cache: Pick<AnswerCache, 'load' | 'lookup'>,
  opts: {
    channel: string;
    question: string;
    tools: readonly FastPathToolSpec[];
    allowedTools: ReadonlySet<string>;
    previous: boolean;
    log: (message: string) => void;
  },
  t0: number,
): Promise<TriageOutcome | undefined> {
  try {
    await cache.load();
    const tools = new Set(opts.tools.map((t) => t.name).filter((n) => opts.allowedTools.has(n)));
    const found = cache.lookup({ question: opts.question, tools, previous: opts.previous });
    const ms = Date.now() - t0;
    if (!found.hit) {
      opts.log(`[fast-path] cache miss channel=${opts.channel} reason=${found.reason} ms=${ms}`);
      return undefined;
    }
    opts.log(`[fast-path] cache hit channel=${opts.channel} tool=${found.plan.fetch.tool} slots=${found.slots} ms=${ms}`);
    return { kind: 'plan', plan: found.plan, ms, cache: { source: 'cache', key: found.key, slots: found.slots } };
  } catch (err) {
    opts.log(`[fast-path] cache miss channel=${opts.channel} reason=error: ${err instanceof Error ? err.message : 'error'}`);
    return undefined;
  }
}

/**
 * The decision model's verdict for a turn: with batch support (`decideAll`)
 * ONE turn-gate request (turnGate.ts — gate, route, plan hint, source and a
 * speculative direct plan with filled slots); without it the sequential
 * gate → source → direct-plan calls (decisionRouter.ts). undefined → the LLM
 * router.
 *
 * A learned plan may run without the planner only for a self-contained turn
 * (no previous query, no digit) while a Privacy Shield RUNS: a plan without
 * placeholders additionally needs a message the shield left unchanged (a
 * masked span is a value the plan lacks); a plan WITH placeholders takes its
 * values from the turn and restores them through the same run.
 */
async function decideTurn(opts: {
  decide: DecisionModelService;
  llm: FastLlm;
  model: string;
  channel: string;
  question: string;
  message: string;
  unmasked: string;
  previous: boolean;
  tools: readonly FastPathToolSpec[];
  offered: readonly LearnedPlan[];
  allowedTools: ReadonlySet<string>;
  intents: readonly RouterIntent[];
  privacy?: StoredTextPrivacyRun;
  directPlans?: boolean;
  onStep: DecisionStepSink;
  onGate: (gate: GateSignal) => void;
  log: (message: string) => void;
}): Promise<{ outcome: RouteOutcome; direct?: PlannedQuery; planHint?: 'plan' | 'direct' } | undefined> {
  const privacy = opts.privacy;
  const eligible = opts.directPlans === true && !opts.previous && privacy !== undefined && !/\d/.test(opts.question);
  if (opts.decide.decideAll) {
    const candidates = eligible
      ? opts.offered.filter((p) => planSlots(planToFetch(p)).length > 0 || opts.message === opts.unmasked)
      : [];
    return turnGateByDecision({
      decide: opts.decide,
      channel: opts.channel,
      message: opts.message,
      question: opts.question,
      tools: opts.tools,
      intents: opts.intents,
      candidates,
      allowedTools: opts.allowedTools,
      restore: privacy ? (text) => privacy.restore(text) : (text) => text,
      onStep: opts.onStep,
      onGate: opts.onGate,
      log: opts.log,
    });
  }
  const routed = await routeByDecision({ ...opts, decide: opts.decide, onStep: opts.onStep, onGate: opts.onGate });
  if (routed?.kind !== 'plan' || !eligible || opts.message !== opts.unmasked) return routed ? { outcome: routed } : undefined;
  const direct = await directPlanByDecision({
    decide: opts.decide,
    channel: opts.channel,
    message: opts.message,
    question: opts.question,
    tool: routed.tool,
    plans: opts.offered,
    allowedTools: opts.allowedTools,
    log: opts.log,
    onStep: opts.onStep,
  });
  if (!direct) return { outcome: routed };
  return {
    outcome: routed.decision ? { ...routed, decision: { ...routed.decision, direct: true } } : routed,
    direct,
  };
}
