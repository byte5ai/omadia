import type { KnowledgeGraph } from '@omadia/plugin-api';

/**
 * #133 (E9) — a compact, serialisable view of a plan's steps, emitted as a
 * `turn_annotation` (channel `plan`) so the chat UI can render the live plan
 * straight from the turn stream — no REST poll, no dev-endpoint dependency.
 *
 * Shape is intentionally flat (not GraphNode) and stable; the web-ui mirrors
 * it (the stream payload crosses the boundary as `unknown`).
 */
export interface PlanStepSnapshot {
  stepExternalId: string;
  order: number;
  goal: string;
  /** pending | in_progress | done | failed | skipped */
  status: string;
}

export interface PlanSnapshot {
  planExternalId: string;
  steps: PlanStepSnapshot[];
  /** Title of the stored process this plan was reused from (no LLM
   *  re-planning). Absent for freshly-materialised plans. Surfaced so the chat
   *  UI can badge the plan as reused. */
  reusedProcessTitle?: string;
}

/** Read the plan's steps from the graph and project them into a PlanSnapshot,
 *  ordered by step order ascending. `opts.reusedProcessTitle` is threaded
 *  through from the plugin (which knows it at materialisation time) so the
 *  snapshot carries reuse provenance without an extra plan-node read. */
export async function buildPlanSnapshot(
  planExternalId: string,
  kg: KnowledgeGraph,
  opts?: { reusedProcessTitle?: string },
): Promise<PlanSnapshot> {
  const steps = await kg.getPlanSteps(planExternalId);
  return {
    planExternalId,
    ...(opts?.reusedProcessTitle
      ? { reusedProcessTitle: opts.reusedProcessTitle }
      : {}),
    steps: steps
      .map((s) => ({
        stepExternalId: s.id,
        order: typeof s.props['order'] === 'number' ? s.props['order'] : 0,
        goal: String(s.props['goal'] ?? ''),
        status: String(s.props['status'] ?? 'pending'),
      }))
      .sort((a, b) => a.order - b.order),
  };
}
