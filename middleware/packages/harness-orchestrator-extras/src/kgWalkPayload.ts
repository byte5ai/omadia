import type {
  KgWalkPayload,
  KnowledgeGraph,
  RecalledContext,
} from '@omadia/plugin-api';

/**
 * KG-walk chat visualization — turn the per-turn cross-session recall into a
 * graph payload of the Knowledge-Graph neighbourhood that recall surfaced.
 *
 * The recall carries three id-bearing legs:
 *   - `insights`  → MemorableKnowledge external_ids (`mk:<uuid>`) + a score
 *   - `processes` → Process external_ids (`process:<scope>:<slug>`) + a score
 *   - `plans`     → Plan external_ids (`plan:<planId>`)
 *
 * We take those as the BFS frontier (hop 0) and ask the KG for the surrounding
 * subgraph, then stamp the recall hit scores onto the matching root nodes so
 * the frontend can visually rank the seeds. Returns `undefined` when there is
 * nothing to walk (empty recall, no resolvable roots, or an empty subgraph) so
 * the caller can simply skip the annotation.
 *
 * Read-only, best-effort, UI-only: the caller MUST guard this so it can never
 * affect or delay the turn / the LLM (the payload is an opaque
 * `turn_annotation`, exactly like `kg_recall`).
 */
export async function buildKgWalkPayload(
  recalled: RecalledContext | undefined,
  kg: KnowledgeGraph,
  opts?: { maxHops?: number; maxNodes?: number },
): Promise<KgWalkPayload | undefined> {
  if (!recalled) return undefined;

  // Collect recall hit scores per root external_id (dedup; keep the max when
  // an id appears in more than one leg). Plans carry no score.
  const scoreById = new Map<string, number>();
  const rootIds: string[] = [];
  const seen = new Set<string>();
  const addRoot = (id: string | undefined, score?: number): void => {
    if (typeof id !== 'string' || id.length === 0) return;
    if (!seen.has(id)) {
      seen.add(id);
      rootIds.push(id);
    }
    if (typeof score === 'number') {
      const prev = scoreById.get(id);
      if (prev === undefined || score > prev) scoreById.set(id, score);
    }
  };

  for (const insight of recalled.insights) addRoot(insight.mkId, insight.score);
  for (const process of recalled.processes) addRoot(process.id, process.score);
  for (const plan of recalled.plans) addRoot(plan.planId);

  if (rootIds.length === 0) return undefined;

  const { nodes, edges } = await kg.getMemorableKnowledgeSubgraph(
    rootIds,
    opts,
  );
  if (nodes.length === 0) return undefined;

  // Stamp recall scores onto the matching root nodes (hop 0). Non-root nodes
  // keep `score` undefined.
  const scoredNodes = nodes.map((n) => {
    const score = scoreById.get(n.id);
    return score === undefined ? n : { ...n, score };
  });

  // Only advertise roots that actually made it into the returned subgraph so
  // the frontend never points at a node that isn't present.
  const presentIds = new Set(scoredNodes.map((n) => n.id));
  const presentRootIds = rootIds.filter((id) => presentIds.has(id));

  return { rootIds: presentRootIds, nodes: scoredNodes, edges };
}

/**
 * KG-insert chat visualization — the sibling of {@link buildKgWalkPayload} for
 * the WRITE side. After a turn auto-promotes a MemorableKnowledge node, walk a
 * tight 1-hop neighbourhood around it and stamp every node + edge with
 * `inserted: true` so the frontend can merge it into the live walk and pulse
 * the freshly-written part of the graph.
 *
 * The inserted MK id becomes the (only) root. Returns `undefined` when the id
 * is empty or the subgraph comes back empty so the caller can skip the
 * annotation. Read-only against the KG, best-effort, UI-only — the caller MUST
 * guard it so it can never affect or delay the turn.
 */
export async function buildKgInsertPayload(
  insertedMkId: string | undefined,
  kg: KnowledgeGraph,
): Promise<KgWalkPayload | undefined> {
  if (typeof insertedMkId !== 'string' || insertedMkId.length === 0) {
    return undefined;
  }

  const { nodes, edges } = await kg.getMemorableKnowledgeSubgraph(
    [insertedMkId],
    { maxHops: 1 },
  );
  if (nodes.length === 0) return undefined;

  const insertedNodes = nodes.map((n) => ({ ...n, inserted: true }));
  const insertedEdges = edges.map((e) => ({ ...e, inserted: true }));

  const presentIds = new Set(insertedNodes.map((n) => n.id));
  const rootIds = presentIds.has(insertedMkId) ? [insertedMkId] : [];

  return { rootIds, nodes: insertedNodes, edges: insertedEdges };
}
