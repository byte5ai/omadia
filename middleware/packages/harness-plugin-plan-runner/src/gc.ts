import type { GraphNode, KnowledgeGraph, LlmAccessor } from '@omadia/plugin-api';

/**
 * #237 (plan GC) — garbage-collect prior semantic-duplicate plans for a scope.
 *
 * The orchestrator re-plans repeatedly within a session: each turn that the
 * gate deems plan-worthy materialises a fresh `Plan` node, so a session whose
 * user keeps refining the same goal ("update the participant…", "modify the
 * planning…", "test the system…") accumulates a pile of near-identical plans in
 * the graph. They are iterations of one task; only the latest is useful.
 *
 * This pass runs right after a new plan is materialised (during execution, not
 * as a batch sweep): it keeps the just-created plan (the latest = the survivor)
 * and hard-deletes prior plans in the same scope that are the SAME task. Two
 * layers, cheapest first:
 *   1. Structural — identical normalised request summary → duplicate, no LLM.
 *   2. Semantic   — a single Haiku call judges the remaining recent candidates
 *      against the survivor ("same underlying task, re-planned?").
 *
 * Never throws (the caller fire-and-forgets); never deletes the survivor or any
 * plan whose turn is still in flight (`protectedPlanExternalIds`).
 */

export const GC_MODEL = 'claude-haiku-4-5';

/** Cap on how many recent prior plans the semantic layer compares in one call.
 *  Older plans age out — bounding keeps the GC to a single small Haiku call. */
const DEFAULT_CANDIDATE_LIMIT = 12;

const GC_SYSTEM = [
  'You are de-duplicating an AI assistant\'s task plans. You are given a',
  'REFERENCE request and a numbered list of EARLIER requests from the same',
  'session. Identify which earlier requests are the SAME underlying task as the',
  'reference — i.e. an earlier iteration / re-plan of the same goal — even when',
  'reworded, partially overlapping, or in a different language.',
  '',
  'Be conservative: only mark an earlier request when you are confident it is',
  'the same task, not merely a related or follow-up one.',
  '',
  'Respond with ONLY a JSON array of the 0-based indices that are the same task',
  '(e.g. [0,2]). Respond with [] when none match. No prose, no code fences.',
].join('\n');

export interface GcInput {
  scope: string;
  /** External id of the just-created plan — the survivor; never deleted. */
  keepPlanExternalId: string;
  /** The survivor's request summary (drives both GC layers). */
  requestSummary: string;
  /** Plan external ids whose turns are still in flight in this process — never
   *  deleted even if they look like duplicates. */
  protectedPlanExternalIds: ReadonlySet<string>;
  llm: Pick<LlmAccessor, 'complete'>;
  kg: KnowledgeGraph;
  /** Override the recent-candidate cap (testing). */
  candidateLimit?: number;
}

export interface GcResult {
  deletedPlanExternalIds: string[];
  deletedSteps: number;
}

const EMPTY: GcResult = { deletedPlanExternalIds: [], deletedSteps: 0 };

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function requestSummaryOf(plan: GraphNode): string | undefined {
  const v = plan.props['requestSummary'];
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/** Tolerant parse of the model's index array: strips fences, keeps in-range
 *  non-negative integers. Returns [] on any failure → no semantic deletions. */
export function parseIndexArray(raw: string, count: number): number[] {
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
  const out = new Set<number>();
  for (const n of data) {
    if (Number.isInteger(n) && n >= 0 && n < count) out.add(n);
  }
  return [...out];
}

/**
 * Run the GC pass. Returns the plans it hard-deleted. Pure of throw: any error
 * degrades to "deleted nothing".
 */
export async function gcSupersededPlans(input: GcInput): Promise<GcResult> {
  const survivorSummary = normalise(input.requestSummary);
  if (survivorSummary.length === 0) return EMPTY;

  let plans: GraphNode[];
  try {
    plans = await input.kg.listPlansForScope(input.scope);
  } catch {
    return EMPTY;
  }

  // Prior plans only: drop the survivor and anything still in flight.
  const candidates = plans.filter(
    (p) =>
      p.id !== input.keepPlanExternalId &&
      !input.protectedPlanExternalIds.has(p.id),
  );
  if (candidates.length === 0) return EMPTY;

  const superseded = new Set<string>();

  // Layer 1 — structural: identical normalised request summary. No LLM.
  const undecided: GraphNode[] = [];
  for (const plan of candidates) {
    const summary = requestSummaryOf(plan);
    if (summary === undefined) continue; // legacy plan — can't compare
    if (normalise(summary) === survivorSummary) {
      superseded.add(plan.id);
    } else {
      undecided.push(plan);
    }
  }

  // Layer 2 — semantic: one Haiku call over the most-recent undecided window
  // (listPlansForScope is most-recent-first, so the slice is the newest set).
  const limit = input.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const window = undecided.slice(0, Math.max(0, limit));
  if (window.length > 0) {
    const numbered = window
      .map((p, i) => `${i}. ${requestSummaryOf(p) ?? ''}`)
      .join('\n');
    try {
      const res = await input.llm.complete({
        model: GC_MODEL,
        system: GC_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `REFERENCE: ${input.requestSummary}\n\nEARLIER:\n${numbered}`,
          },
        ],
        maxTokens: 64,
        temperature: 0,
      });
      for (const idx of parseIndexArray(res.text, window.length)) {
        const plan = window[idx];
        if (plan) superseded.add(plan.id);
      }
    } catch {
      // Semantic layer unavailable — keep the structural deletions only.
    }
  }

  // Hard-delete, accumulating counts. A failed delete is skipped, not fatal.
  const deletedPlanExternalIds: string[] = [];
  let deletedSteps = 0;
  for (const planId of superseded) {
    try {
      const { deleted, deletedSteps: steps } = await input.kg.deletePlan(planId);
      if (deleted) {
        deletedPlanExternalIds.push(planId);
        deletedSteps += steps;
      }
    } catch {
      // skip
    }
  }
  return { deletedPlanExternalIds, deletedSteps };
}
