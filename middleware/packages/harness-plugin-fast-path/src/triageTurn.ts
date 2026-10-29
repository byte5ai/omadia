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
 */

export type TriageOutcome =
  | { kind: 'plan'; plan: PlannedQuery; ms: number }
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
  log: (message: string) => void;
}): Promise<TriageOutcome> {
  const t0 = Date.now();
  const agent = (reason: string, route?: TriageRoute): TriageOutcome => ({
    kind: 'agent',
    reason,
    ms: Date.now() - t0,
    ...(route ? { route } : {}),
  });
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
  return { kind: 'plan', plan: planned.plan, ms: Date.now() - t0 };
}
