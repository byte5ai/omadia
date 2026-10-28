import type { GraphNode, GraphNodeType, KnowledgeGraph } from '@omadia/plugin-api';

/**
 * #1540 — a plugin's `ctx.knowledgeGraph.getNeighbors` under a Privacy Shield.
 *
 * The recall legs and a plugin's turn search skip content of turns stored
 * `unprotected` (#1507, #1536). A neighbour walk returned every node as
 * stored: unprotected Turns, Facts extracted from them, MemorableKnowledge
 * derived from them, run traces with tool arguments. Inside a turn that runs
 * under a shield this filter keeps:
 *
 *  - reference nodes that hold no conversation text (sessions, entities,
 *    users, channel identities);
 *  - a Turn not stored `unprotected`;
 *  - a Fact or a Plan linked to a known Turn, none of them `unprotected`
 *    (no linked Turn: provenance unknown, dropped);
 *  - a MemorableKnowledge not stamped `unprotected` and linked to no
 *    `unprotected` Turn, as the memory recall leg does;
 *  - a PalaiaExcerpt whose memories all pass that check.
 *
 * Every other derived node (run traces, plan steps, topics, conflict and
 * duplicate markers) is dropped: none carries provenance to check.
 */

const REFERENCE_TYPES: ReadonlySet<GraphNodeType> = new Set<GraphNodeType>([
  'Session',
  'OdooEntity',
  'ConfluencePage',
  'PluginEntity',
  'User',
  'ChannelIdentity',
]);

type NeighborGraph = Pick<KnowledgeGraph, 'getNeighbors'>;

function isStampedUnprotected(node: GraphNode): boolean {
  return node.props['unprotected'] === true;
}

/** Linked to at least one Turn, and to no `unprotected` one. */
async function hasProtectedTurn(kg: NeighborGraph, node: GraphNode): Promise<boolean> {
  const turns = (await kg.getNeighbors(node.id)).filter((n) => n.type === 'Turn');
  return turns.length > 0 && !turns.some(isStampedUnprotected);
}

/** Not stamped, and linked to no `unprotected` Turn (a missing link is fine). */
async function isProtectedMemory(kg: NeighborGraph, node: GraphNode): Promise<boolean> {
  if (isStampedUnprotected(node)) return false;
  const neighbors = await kg.getNeighbors(node.id);
  return !neighbors.some((n) => n.type === 'Turn' && isStampedUnprotected(n));
}

async function isProtectedExcerpt(kg: NeighborGraph, node: GraphNode): Promise<boolean> {
  const memories = (await kg.getNeighbors(node.id)).filter((n) => n.type === 'MemorableKnowledge');
  if (memories.length === 0) return false;
  for (const memory of memories) {
    if (!(await isProtectedMemory(kg, memory))) return false;
  }
  return true;
}

async function keepUnderShield(kg: NeighborGraph, node: GraphNode): Promise<boolean> {
  if (isStampedUnprotected(node)) return false;
  if (REFERENCE_TYPES.has(node.type) || node.type === 'Turn') return true;
  switch (node.type) {
    case 'Fact':
    case 'Plan':
      return hasProtectedTurn(kg, node);
    case 'MemorableKnowledge':
      return isProtectedMemory(kg, node);
    case 'PalaiaExcerpt':
      return isProtectedExcerpt(kg, node);
    default:
      return false;
  }
}

/** `getNeighbors` for a plugin; filtered when `shieldActive`. */
export async function neighborsForPlugin(
  kg: NeighborGraph,
  nodeId: string,
  shieldActive: boolean,
): Promise<GraphNode[]> {
  const neighbors = await kg.getNeighbors(nodeId);
  if (!shieldActive) return neighbors;
  const kept: GraphNode[] = [];
  for (const node of neighbors) {
    if (await keepUnderShield(kg, node)) kept.push(node);
  }
  return kept;
}
