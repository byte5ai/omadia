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
}

/** Read the plan's steps from the graph and project them into a PlanSnapshot,
 *  ordered by step order ascending. */
export async function buildPlanSnapshot(
  planExternalId: string,
  kg: KnowledgeGraph,
): Promise<PlanSnapshot> {
  const steps = await kg.getPlanSteps(planExternalId);
  return {
    planExternalId,
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
