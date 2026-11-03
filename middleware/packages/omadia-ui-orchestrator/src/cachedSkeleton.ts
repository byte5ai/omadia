import type { PlannedQuery, TriageOutcome } from '@omadia/fast-path';
import type { SkeletonResult } from './composition.js';
import { questionTitle } from './decisionCanvas.js';

/**
 * Skeleton for a planned turn — no composer call. Built for an answer-cache
 * hit and, with a decision model, for every turn its gate routes to data.
 *
 * A cache hit (@omadia/fast-path answerCache.ts) skips router + planner, but
 * the canvas still waited ~2–2.6 s for the skeleton composer (live, v431):
 * the composer alone bounded the turn. A cached plan already knows its ONE
 * table — columns and headers — so the skeleton is built from it: a heading
 * with the user's own question and the table, which the fast path then fills.
 * The text stays local (it is the user's own question, shown back to them).
 */

/** Safety cap on waiting for the cache verdict before composing — the
 *  lookup reports in a few ms (`onCacheLookup`, before router + planner). */
export const CACHE_PEEK_MS = 100;

const TABLE_ID = 'results';

/** The cached plan when the turn's cache lookup reports a hit (within
 *  `ms`), else undefined — a miss returns as soon as the lookup ran, so a
 *  normal turn's composer starts a few ms later, never `ms` later. */
export async function peekCacheHit(
  triage: Promise<TriageOutcome> | undefined,
  verdict: Promise<boolean> | undefined,
  ms = CACHE_PEEK_MS,
): Promise<PlannedQuery | undefined> {
  if (triage === undefined || verdict === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    if (!(await Promise.race([verdict, timeout]))) return undefined;
  } finally {
    clearTimeout(timer);
  }
  const t = await triage.catch(() => undefined);
  return t?.kind === 'plan' && t.cache?.source === 'cache' ? t.plan : undefined;
}

/** The skeleton of a plan: heading + its ONE table (plan headers). */
export function planSkeleton(plan: PlannedQuery, question: string): SkeletonResult {
  const fields = Object.keys(plan.fetch.map).map((fieldKey) => ({
    fieldKey,
    label: plan.labels[fieldKey] ?? fieldKey,
  }));
  const heading = questionTitle(question);
  return {
    tree: {
      type: 'container',
      id: 'root',
      layout: 'stack',
      children: [
        { type: 'heading', content: heading, level: 2 },
        { type: 'table', id: TABLE_ID, loading: 'skeleton', columns: fields, rows: [] },
      ],
    },
    dataRequirements: [{ containerId: TABLE_ID, description: heading, fields }],
    source: 'plan',
  };
}
