import type { PlannedQuery, TriageOutcome } from '@omadia/fast-path';
import type { SkeletonResult } from './composition.js';

/**
 * Skeleton for an answer-cache hit — no composer call.
 *
 * A cache hit (@omadia/fast-path answerCache.ts) skips router + planner, but
 * the canvas still waited ~2–2.6 s for the skeleton composer (live, v431):
 * the composer alone bounded the turn. A cached plan already knows its ONE
 * table — columns and headers — so the skeleton is built from it: a heading
 * with the user's own question and the table, which the fast path then fills.
 * The text stays local (it is the user's own question, shown back to them).
 */

/** How long the skeleton waits for the cache verdict before composing — a
 *  hit resolves in a few ms; anything slower is no hit worth waiting for. */
export const CACHE_PEEK_MS = 100;

const TABLE_ID = 'results';
const MAX_TITLE = 80;

/** The cached plan of `triage` when it resolves as an answer-cache hit
 *  within `ms`, else undefined (miss, LLM plan, agent route, slow). */
export async function peekCacheHit(
  triage: Promise<TriageOutcome> | undefined,
  ms = CACHE_PEEK_MS,
): Promise<PlannedQuery | undefined> {
  if (triage === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  const hit = triage.then(
    (t) => (t.kind === 'plan' && t.cache?.source === 'cache' ? t.plan : undefined),
    () => undefined,
  );
  try {
    return await Promise.race([hit, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The question as a heading: one line, no trailing question mark, capped. */
function title(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim().replace(/[?？]+$/, '');
  const capped = line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/** The skeleton of a cached plan: heading + its ONE table (plan headers). */
export function planSkeleton(plan: PlannedQuery, question: string): SkeletonResult {
  const fields = Object.keys(plan.fetch.map).map((fieldKey) => ({
    fieldKey,
    label: plan.labels[fieldKey] ?? fieldKey,
  }));
  const heading = title(question);
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
