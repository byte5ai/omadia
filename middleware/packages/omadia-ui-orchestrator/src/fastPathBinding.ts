import type { PlannedQuery } from '@omadia/fast-path';

import type { SkeletonResult } from './composition.js';

/**
 * Binds a speculative fast-path plan (planned WITHOUT the skeleton — it runs
 * in parallel with the composer) to the skeleton afterwards.
 *
 * Exactly ONE data container, and it is a table: the plan fills it, and the
 * plan's columns (map keys + the planner's labels) REPLACE the composer's
 * columns — published as `datasetColumns`, the column-replacement path of
 * patchComposition (#326), so cells resolve by the plan's keys whatever the
 * composer named them. Anything else is a reasoned miss and the agent fills
 * the skeleton as before.
 */

export interface PlanColumn {
  fieldKey: string;
  label: string;
}

/** The skeleton with the plan applied: the target requirement carries the
 *  `fetch` (and the plan's columns as its fields), plus the prose template,
 *  locale and the columns that replace the table's. */
export type PlannedSkeleton = SkeletonResult & {
  summary?: string;
  locale?: string;
  planColumns?: PlanColumn[];
};

export type PlanBinding = { ok: true; skeleton: PlannedSkeleton } | { ok: false; reason: string };

/** The node with `id` in a primitive tree (any depth, any child key). */
function findNode(node: unknown, id: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, id);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof node !== 'object' || node === null) return undefined;
  const rec = node as Record<string, unknown>;
  if (rec['id'] === id && typeof rec['type'] === 'string') return rec;
  for (const value of Object.values(rec)) {
    const hit = findNode(value, id);
    if (hit) return hit;
  }
  return undefined;
}

export function bindPlanToSkeleton(skeleton: SkeletonResult, plan: PlannedQuery): PlanBinding {
  if (skeleton.source === 'fallback' || skeleton.dataRequirements.length === 0) return { ok: false, reason: 'no-plan' };
  if (skeleton.dataRequirements.length > 1) return { ok: false, reason: 'multi-container' };
  const req = skeleton.dataRequirements[0]!;
  if (findNode(skeleton.tree, req.containerId)?.['type'] !== 'table') return { ok: false, reason: 'not-a-table' };
  const planColumns = Object.keys(plan.fetch.map).map((fieldKey) => ({
    fieldKey,
    label: plan.labels[fieldKey] ?? fieldKey,
  }));
  return {
    ok: true,
    skeleton: {
      ...skeleton,
      dataRequirements: [{ ...req, fields: planColumns, fetch: plan.fetch }],
      summary: plan.summary,
      ...(plan.locale !== undefined ? { locale: plan.locale } : {}),
      planColumns,
    },
  };
}
