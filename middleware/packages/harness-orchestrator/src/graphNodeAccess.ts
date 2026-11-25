import {
  canonicalOwners,
  ownersCoverAudience,
  scopeBelongsToAgent,
  userNodeId,
  type GraphNode,
  type KgWalkPayload,
  type KnowledgeGraph,
} from '@omadia/plugin-api';
import { graphViewAccess, type KnowledgeGraphToolView } from './knowledgeGraphTool.js';
import { graphScopeFor } from './sessionLogger.js';
import { turnContext, type GraphReadScope } from './turnContext.js';

/**
 * #2208 / #1825 — which graph NODES a turn may see, for reads that walk the
 * graph instead of searching it: a plugin's `getNeighbors` and the `kg_graph`
 * / `kg_insert` walk sent to the client. Both returned every neighbour as
 * stored: other people's private memories, plans, turns and sessions next to
 * anything the turn could reach.
 *
 * The rules are the turn's own graph boundary (`GraphReadScope`), node type by
 * node type, the same ones the recall legs and the graph tool apply:
 *
 *  - Turn / Session: readable through the boundary's session read (agent,
 *    user or audience, exact conversation). Outside the turn's own
 *    conversation a tail-only turn, and under a shield an `unprotected` one,
 *    stays out, as in recall (#1096, #1507).
 *  - MemorableKnowledge: `members` — everyone present owns it, or operator-
 *    authored, of this agent; `enforce-strict` — the shared tier only;
 *    `off` / `enforce` — the viewer owns it (this agent), or it is shared and
 *    the deployment's team recall is on. A PalaiaExcerpt follows its memories.
 *  - Entities: global in `off` / `enforce`; otherwise only next to a visible
 *    turn, as the graph tool reaches them.
 *  - Plan: this agent's, in `off` / `enforce` only. Fact: only when every
 *    turn it came from is visible.
 *  - User: only the viewer's own. Everything else (run traces, identities,
 *    topics, conflict and duplicate markers) carries no owner and is dropped.
 */
export interface GraphNodeViewer {
  readonly bound: GraphReadScope;
  /** This agent's slug: memories of another agent stay out. */
  readonly agentSlug: string;
  /** Every id the viewer owns memory under (channel id, omadia user id). */
  readonly viewerIds: readonly string[];
  /** `off` / `enforce`: admit shared (`team`/`public`) memories. Default off. */
  readonly teamVisibility?: boolean;
  /** Ids the caller already admitted through its own ACL (recall hits). */
  readonly trusted?: ReadonlySet<string>;
  /** The turn's own conversation (graph scope): its tail reads in full. */
  readonly ownScope?: string;
  /** The turn runs under a Privacy Shield. */
  readonly shielded?: boolean;
}

type NodeGraph = Pick<KnowledgeGraph, 'getSession' | 'getNeighbors'>;

const ENTITY_TYPES = new Set(['OdooEntity', 'ConfluencePage', 'PluginEntity']);

function toolViewFor(bound: GraphReadScope): KnowledgeGraphToolView {
  switch (bound.kind) {
    case 'conversation':
      return { restrictToScope: bound.scope };
    case 'members':
      return { audienceOwners: bound.audience, agentScopePrefix: bound.agentScopePrefix };
    case 'user':
      return { userId: bound.userId, agentScopePrefix: bound.agentScopePrefix, ownScope: bound.ownScope };
    case 'nothing':
      return { audienceOwners: null, agentScopePrefix: '' };
  }
}

function stringProp(node: GraphNode, key: string): string | undefined {
  const v = node.props[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** A predicate over graph nodes for one turn. Caches session reads. */
export function graphNodeFilter(
  graph: NodeGraph,
  viewer: GraphNodeViewer,
): (node: GraphNode) => Promise<boolean> {
  const { bound } = viewer;
  const access = graphViewAccess(graph, toolViewFor(bound));
  const sessions = new Map<string, Promise<Set<string> | null>>();
  const visibleTurns = (scope: string): Promise<Set<string> | null> => {
    let hit = sessions.get(scope);
    if (!hit) {
      hit = access.scopeAllowed(scope)
        ? access.readSession(scope).then((s) => (s ? new Set(s.turns.map((t) => t.turn.id)) : null))
        : Promise.resolve(null);
      sessions.set(scope, hit);
    }
    return hit;
  };

  const turnVisible = async (node: GraphNode): Promise<boolean> => {
    const scope = stringProp(node, 'scope');
    if (scope === undefined) return false;
    if (scope !== viewer.ownScope) {
      if (node.props['tailOnly'] === true) return false;
      if (viewer.shielded === true && node.props['unprotected'] === true) return false;
    }
    return (await visibleTurns(scope))?.has(node.id) ?? false;
  };

  const memoryVisible = (node: GraphNode): boolean => {
    const owners = Array.isArray(node.props['acl_owners'])
      ? (node.props['acl_owners'] as unknown[]).filter((o): o is string => typeof o === 'string')
      : [];
    const origin = stringProp(node, 'origin_agent');
    const agentOk = origin === undefined || origin === viewer.agentSlug;
    const shared = ['team', 'public'].includes(node.visibility ?? 'team');
    switch (bound.kind) {
      case 'nothing':
        return false;
      case 'conversation':
        return shared;
      case 'members': {
        if (!bound.audience || !agentOk) return false;
        const operator =
          node.manuallyAuthored === true && !(stringProp(node, 'created_by') ?? '').startsWith('auto:');
        return ownersCoverAudience(owners, canonicalOwners(bound.audience)) || operator;
      }
      case 'user':
        return (
          (agentOk && owners.some((o) => viewer.viewerIds.includes(o))) ||
          (viewer.teamVisibility === true && shared)
        );
    }
  };

  const neighborsOfType = async (node: GraphNode, type: string): Promise<GraphNode[]> =>
    (await graph.getNeighbors(node.id)).filter((n) => n.type === type);

  const visible = async (node: GraphNode): Promise<boolean> => {
    if (viewer.trusted?.has(node.id)) return true;
    if (bound.kind === 'nothing') return false;
    switch (node.type) {
      case 'Turn':
        return turnVisible(node);
      case 'Session': {
        const scope = stringProp(node, 'scope');
        return scope !== undefined && (await visibleTurns(scope)) !== null;
      }
      case 'MemorableKnowledge':
        return memoryVisible(node);
      case 'PalaiaExcerpt': {
        const memories = await neighborsOfType(node, 'MemorableKnowledge');
        return memories.length > 0 && memories.every(memoryVisible);
      }
      case 'Plan': {
        const scope = stringProp(node, 'scope');
        return bound.kind === 'user' && scope !== undefined && scopeBelongsToAgent(scope, bound.agentScopePrefix);
      }
      case 'Fact': {
        const turns = await neighborsOfType(node, 'Turn');
        if (turns.length === 0) return false;
        for (const t of turns) if (!(await turnVisible(t))) return false;
        return true;
      }
      case 'User':
        return viewer.viewerIds.some((id) => userNodeId(id) === node.id);
      default:
        if (!ENTITY_TYPES.has(node.type)) return false;
        if (bound.kind === 'user') return true;
        for (const t of await neighborsOfType(node, 'Turn')) if (await turnVisible(t)) return true;
        return false;
    }
  };
  return visible;
}

/** The neighbours of `nodeId` the filter admits. */
export async function visibleNeighbors(
  graph: NodeGraph,
  nodeId: string,
  visible: (node: GraphNode) => Promise<boolean>,
): Promise<GraphNode[]> {
  const neighbors = await graph.getNeighbors(nodeId);
  const keep = await Promise.all(neighbors.map(visible));
  return neighbors.filter((_, i) => keep[i]);
}

/**
 * A `kg_graph` / `kg_insert` walk cut to what the viewer may see. The walk
 * follows only admitted nodes from its roots, so it never reaches a node
 * through one the viewer may not see (another person's User node, a turn of
 * another conversation). The roots are the caller's own recall hits and stay.
 */
export async function boundKgWalk(
  payload: KgWalkPayload,
  graph: NodeGraph,
  visible: (node: GraphNode) => Promise<boolean>,
): Promise<KgWalkPayload | undefined> {
  const inWalk = new Set(payload.nodes.map((n) => n.id));
  const reached = new Set(payload.rootIds);
  let frontier = [...payload.rootIds];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of await visibleNeighbors(graph, id, visible)) {
        if (!inWalk.has(n.id) || reached.has(n.id)) continue;
        reached.add(n.id);
        next.push(n.id);
      }
    }
    frontier = next;
  }
  const nodes = payload.nodes.filter((n) => reached.has(n.id));
  if (nodes.length === 0) return undefined;
  return {
    ...payload,
    nodes,
    edges: payload.edges.filter((e) => reached.has(e.from) && reached.has(e.to)),
  };
}

/**
 * The viewer of the current turn, or undefined outside a turn whose graph
 * boundary is set (background jobs, activation): those reads stay as they are.
 */
export function currentGraphNodeViewer(
  extra?: Pick<GraphNodeViewer, 'trusted' | 'teamVisibility'>,
): GraphNodeViewer | undefined {
  const ctx = turnContext.current();
  const bound = ctx?.graphReadScope?.value;
  if (!ctx || !bound) return undefined;
  const ids = [ctx.userId, ctx.resolvedOmadiaUserId, bound.kind === 'user' ? bound.userId : undefined];
  const agentSlug = ctx.agentSlug ?? 'default';
  return {
    bound,
    agentSlug,
    ...(ctx.sessionScope ? { ownScope: graphScopeFor(agentSlug, ctx.sessionScope) } : {}),
    shielded: ctx.privacyHandle !== undefined,
    viewerIds: [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))],
    ...extra,
  };
}
