import type { AnswerCache, CacheTicket } from './answerCache.js';
import type { FastLlm, FastPathToolSpec } from './fastPath.js';
import type { LearnedPlan } from './learnedPlanStore.js';
import { planQuery } from './planner.js';
import { routeTurn } from './router.js';
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
 */

export type TriageOutcome =
  | { kind: 'plan'; plan: PlannedQuery; ms: number; cache?: CacheTicket }
  | { kind: 'agent'; route?: TriageRoute; reason: string; ms: number };

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
  log: (message: string) => void;
}): Promise<TriageOutcome> {
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
  let message = buildTurnMessage(opts);
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
  // speculative: started BEFORE the router answers; never throws
  const planning = planQuery({
    ...base,
    question: opts.question,
    allowedTools: opts.allowedTools,
    examples: opts.offered,
    ...(privacy ? { restore: (text: string) => privacy.restore(text) } : {}),
  });
  const route = await routeTurn({
    ...base,
    intents: opts.offered.map((p) => ({ question: p.examples[0] ?? '', tool: p.tool })),
  });
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
