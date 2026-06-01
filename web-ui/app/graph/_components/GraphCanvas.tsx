'use client';

import { useEffect, useMemo, useRef } from 'react';
import cytoscape from 'cytoscape';
import type {
  Core,
  ElementDefinition,
  EventObject,
  LayoutOptions,
  NodeCollection,
  NodeSingular,
} from 'cytoscape';
import fcose from 'cytoscape-fcose';
import {
  DEFAULT_FILTER,
  TRACE_TYPES,
  type GraphFilter,
  type GraphNode,
  type IssueOverlay,
  type MemoryView,
  type NodeType,
  type PlanOverlay,
  type RunTraceView,
  type SessionView,
  type TopicOverlay,
  nodeColor,
  nodeLabel,
  planStepColor,
} from './graphTypes';

let fcoseRegistered = false;
function ensureFcose(): void {
  if (fcoseRegistered) return;
  cytoscape.use(fcose);
  fcoseRegistered = true;
}

interface ExpansionNeighbor {
  source: string;
  neighbors: GraphNode[];
}

interface Props {
  session: SessionView | null;
  /** Additional top-level sessions rendered as hub nodes (for '__ALL__' view). */
  extraSessions?: SessionView[];
  runs: Record<string, RunTraceView>;
  expansions: ExpansionNeighbor[];
  /** Slice — Palaia Focused View. When present and the filter has
   *  `showMemories=true` (or `focusMemories` is set), MemorableKnowledge
   *  + PalaiaExcerpt nodes plus their 2-hop provenance edges are merged
   *  into the rendered graph. */
  memoryView?: MemoryView | null;
  /** When true the canvas hides everything except the memory subgraph
   *  (memories + Lvl-1 + Lvl-2 ancestors). Used by the dedicated
   *  "Memory" view-mode tab and the "🧠 Alle Memories" sidebar entry. */
  focusMemories?: boolean;
  /** Slice 11.5 — Topic overlay (every Topic node + HAS_TOPIC edges).
   *  Rendered when `filter.showTopics=true`. */
  topicOverlay?: TopicOverlay | null;
  /** Slice 11.5 — Issue overlay (Inconsistency + MergeCandidate +
   *  CONFLICTS_WITH/DUPLICATE_OF edges). Rendered when
   *  `filter.showIssues=true`. */
  issueOverlay?: IssueOverlay | null;
  /** #133 — per-turn plan DAG overlay (Plan + PlanStep nodes + STEP_OF /
   *  DEPENDS_ON edges). Rendered when `filter.showPlans=true`. */
  planOverlay?: PlanOverlay | null;
  selectedId: string | null;
  filter?: GraphFilter;
  onSelectNode: (node: GraphNode | null) => void;
  onExpandNode: (nodeId: string) => void;
  dark?: boolean;
}

interface BuiltElements {
  nodes: Map<string, GraphNode>;
  mentionCounts: Map<string, number>;
  elements: ElementDefinition[];
}

const ENTITY_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'OdooEntity',
  'ConfluencePage',
]);

function buildElements(
  session: SessionView | null,
  extraSessions: SessionView[],
  runs: Record<string, RunTraceView>,
  expansions: ExpansionNeighbor[],
  filter: GraphFilter,
  memoryView: MemoryView | null,
  focusMemories: boolean,
  topicOverlay: TopicOverlay | null,
  issueOverlay: IssueOverlay | null,
  planOverlay: PlanOverlay | null,
): BuiltElements {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, ElementDefinition>();
  const mentionCounts = new Map<string, number>();

  const addNode = (n: GraphNode): void => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };

  const addEdge = (
    source: string,
    target: string,
    label: string,
    extra: Record<string, unknown> = {},
  ): void => {
    const id = `${source}__${target}__${label}`;
    if (edges.has(id)) return;
    edges.set(id, {
      data: { id, source, target, label, ...extra },
      group: 'edges',
    });
  };

  // turnId → sessionId so we can re-attribute edges when trace nodes are hidden
  const turnToSession = new Map<string, string>();
  const allSessions: SessionView[] = [];
  if (session) allSessions.push(session);
  for (const sv of extraSessions) allSessions.push(sv);
  for (const sv of allSessions) {
    for (const { turn } of sv.turns) {
      turnToSession.set(turn.id, sv.session.id);
    }
  }

  // Aggregate mentions to (sessionId → entityId → count) regardless of toggle
  // — count is needed for entity sizing; the edge itself is gated by showMentions.
  const sessionMentions = new Map<string, Map<string, number>>();
  const bumpMention = (sessionId: string, entityId: string): void => {
    let m = sessionMentions.get(sessionId);
    if (!m) {
      m = new Map<string, number>();
      sessionMentions.set(sessionId, m);
    }
    m.set(entityId, (m.get(entityId) ?? 0) + 1);
    mentionCounts.set(entityId, (mentionCounts.get(entityId) ?? 0) + 1);
  };

  const addSessionView = (sv: SessionView): void => {
    addNode(sv.session);
    // Slice 1b-channel-web — render the User-Cluster as a first-class
    // neighbor of the session (BELONGS_TO is the canonical relation in
    // the graph; we surface it as TRIGGERED here to align with the
    // existing run-user visualisation).
    if (sv.user) {
      addNode(sv.user);
      addEdge(sv.user.id, sv.session.id, 'TRIGGERED');
    }
    for (const { turn, entities } of sv.turns) {
      if (filter.showTrace) {
        addNode(turn);
        addEdge(sv.session.id, turn.id, 'HAS_TURN');
      }
      for (const e of entities) {
        if (filter.showEntities || e.type === 'User') addNode(e);
        bumpMention(sv.session.id, e.id);
      }
    }
  };

  for (const sv of allSessions) addSessionView(sv);

  // Aggregated Session→Entity mention edges (one per pair, with count).
  if (filter.showMentions) {
    for (const [sessionId, ents] of sessionMentions) {
      for (const [entityId, count] of ents) {
        if (!nodes.has(entityId)) continue;
        addEdge(sessionId, entityId, 'MENTIONS', { count });
      }
    }
  }

  for (const [turnId, run] of Object.entries(runs)) {
    const sessionId = turnToSession.get(turnId);
    // User is treated as a real actor — show whenever we have one.
    if (run.user) addNode(run.user);

    // Surrogate source for re-attributed edges when trace nodes are hidden.
    const surrogate = run.user?.id ?? sessionId;

    if (filter.showTrace) {
      addNode(run.run);
      addEdge(turnId, run.run.id, 'RAN');
      if (run.user) addEdge(run.user.id, run.run.id, 'TRIGGERED');
    } else if (run.user && sessionId) {
      // Anchor user to the session even without trace nodes.
      addEdge(run.user.id, sessionId, 'TRIGGERED');
    }

    const emitProduced = (
      toolNode: GraphNode,
      entity: GraphNode,
      agentNode?: GraphNode,
    ): void => {
      if (!filter.showEntities && entity.type !== 'User') return;
      addNode(entity);
      if (filter.showTrace) {
        addEdge(toolNode.id, entity.id, 'PRODUCED');
      } else if (surrogate) {
        const via = String(
          (toolNode.props['toolName'] ?? toolNode.props['displayName']) ?? '',
        );
        const agentLabel = agentNode
          ? String(
              agentNode.props['agentName'] ?? agentNode.props['displayName'] ?? '',
            )
          : '';
        addEdge(surrogate, entity.id, 'PRODUCED', { via, agent: agentLabel });
      }
    };

    for (const tc of run.orchestratorToolCalls) {
      if (filter.showTrace) {
        addNode(tc.node);
        addEdge(run.run.id, tc.node.id, 'CALLED');
      }
      for (const e of tc.producedEntities) emitProduced(tc.node, e);
    }
    for (const inv of run.agentInvocations) {
      if (filter.showTrace) {
        addNode(inv.node);
        addEdge(run.run.id, inv.node.id, 'INVOKED');
      }
      for (const tc of inv.toolCalls) {
        if (filter.showTrace) {
          addNode(tc.node);
          addEdge(inv.node.id, tc.node.id, 'CALLED');
        }
        for (const e of tc.producedEntities) emitProduced(tc.node, e, inv.node);
      }
    }
  }

  if (filter.showCrossRefs) {
    for (const { source, neighbors } of expansions) {
      for (const n of neighbors) {
        // Only render expanded entities — trace neighbors would re-clutter.
        if (TRACE_TYPES.has(n.type) && !filter.showTrace) continue;
        if (!filter.showEntities && ENTITY_TYPES.has(n.type)) continue;
        addNode(n);
        addEdge(source, n.id, 'RELATED');
      }
    }
  }

  // Memory Focused View — inject MK/Excerpt nodes + the 2-hop provenance
  // edges returned by `/dev/graph/memories`. The toggle is gated by either
  // `showMemories` (overlay in the regular graph view) or `focusMemories`
  // (dedicated Memory tab / sidebar entry).
  //
  // Order matters: memory MUST be injected BEFORE the topic + issue
  // overlays so the Topic / CONFLICTS_WITH / DUPLICATE_OF edges find
  // their MK endpoint already in `nodes` and render properly. (Earlier
  // versions of Slice 11.5 had this reversed, which silently dropped
  // every HAS_TOPIC edge in the memory-focus view.)
  const memorySet = new Set<string>();
  if (memoryView && (filter.showMemories || focusMemories)) {
    for (const m of memoryView.memories) {
      addNode(m.node);
      memorySet.add(m.node.id);
      for (const n of m.level1) {
        addNode(n);
        memorySet.add(n.id);
      }
      for (const n of m.level2) {
        addNode(n);
        memorySet.add(n.id);
      }
    }
    for (const e of memoryView.edges) {
      if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
      addEdge(e.from, e.to, e.type);
    }
  }

  // Slice 11.5 — Topic overlay. Inject Topic nodes + HAS_TOPIC edges.
  // Edges are only rendered when the MK endpoint is already in the
  // canvas (memoryView or session entities), so an unmoored Topic
  // node may still appear in the canvas if its members are out of
  // scope — that's intentional, the operator sees the full clustering
  // landscape even if only a slice of MKs is loaded.
  if (topicOverlay && filter.showTopics) {
    for (const t of topicOverlay.topics) addNode(t);
    for (const e of topicOverlay.edges) {
      if (!nodes.has(e.from)) continue;
      addEdge(e.from, e.to, 'HAS_TOPIC');
    }
    // Inferred Excerpt → Topic membership: an Excerpt conceptually
    // belongs to the same topic its parent MK was clustered into. The
    // schema doesn't store this directly (Topics only know MKs), but
    // visually it's much more useful to show the Excerpts as part of
    // the cluster than dangling off their MK alone. Edge label
    // 'HAS_TOPIC_INDIRECT' gets a dotted style so the inferred
    // relationship reads as weaker than the real HAS_TOPIC.
    const mkToTopic = new Map<string, string>();
    for (const e of topicOverlay.edges) mkToTopic.set(e.from, e.to);
    for (const ed of [...edges.values()]) {
      const d = ed.data as { source: string; target: string; label: string };
      if (d.label !== 'EXCERPT_OF') continue;
      const topicId = mkToTopic.get(d.target);
      if (!topicId) continue;
      if (!nodes.has(d.source) || !nodes.has(topicId)) continue;
      addEdge(d.source, topicId, 'HAS_TOPIC_INDIRECT');
    }
  }

  // Slice 11.5 — Issue overlay. Inconsistency + MergeCandidate plus
  // their MK-side edges. The MK side (`e.to`) must already be in the
  // canvas for the edge to make sense; the marker itself is always
  // added so the operator can see open issues even when no source MK
  // is loaded yet.
  if (issueOverlay && filter.showIssues) {
    for (const n of issueOverlay.inconsistencies) addNode(n);
    for (const n of issueOverlay.mergeCandidates) addNode(n);
    // Slice 12.5 — Excerpt-side duplicates are part of the same issue
    // mental model. The `to` side is a PalaiaExcerpt, which is only in
    // the canvas when `showMemories` is on; the edge is pruned otherwise
    // by the same `nodes.has(e.to)` guard the MK-edges use.
    for (const n of issueOverlay.excerptMergeCandidates) addNode(n);
    for (const e of issueOverlay.edges) {
      if (!nodes.has(e.to)) continue;
      addEdge(e.from, e.to, e.type);
    }
  }

  // Prune isolated entity nodes when the user has no way to see them
  // connected (no PRODUCED, no MENTIONS edge, no expansion). Avoids floating
  // dots that carry no relational meaning in the current view.
  if (!filter.showMentions) {
    const connected = new Set<string>();
    for (const ed of edges.values()) {
      const d = ed.data as { source: string; target: string };
      connected.add(d.source);
      connected.add(d.target);
    }
    for (const [id, n] of [...nodes]) {
      if (ENTITY_TYPES.has(n.type) && !connected.has(id)) nodes.delete(id);
    }
  }

  // Focused Memory mode — drop every node + edge that isn't part of the
  // memory subgraph. Cleaner canvas with only ⭐/❝ memories and their
  // direct ancestors visible. Slice 11.5: Topic / Inconsistency /
  // MergeCandidate nodes that the operator explicitly opted into via
  // `showTopics` / `showIssues` are kept (they're conceptually a
  // *member* of the memory neighbourhood, not noise).
  // #133 — Plan overlay. Inject Plan + PlanStep nodes, STEP_OF edges to the
  // plan, and DEPENDS_ON edges between steps (resolved via raw stepId).
  if (planOverlay && filter.showPlans) {
    for (const { plan, steps } of planOverlay.plans) {
      addNode(plan);
      const byRawId = new Map<string, string>();
      for (const s of steps) {
        const raw = s.props['stepId'];
        if (typeof raw === 'string') byRawId.set(raw, s.id);
      }
      for (const s of steps) {
        addNode(s);
        addEdge(s.id, plan.id, 'STEP_OF');
        const deps = s.props['dependsOn'];
        if (Array.isArray(deps)) {
          for (const dep of deps) {
            const target =
              typeof dep === 'string' ? byRawId.get(dep) : undefined;
            if (target) addEdge(s.id, target, 'DEPENDS_ON');
          }
        }
      }
    }
  }

  if (focusMemories && memoryView) {
    for (const [id, n] of [...nodes]) {
      if (memorySet.has(id)) continue;
      if (
        n.type === 'Topic' ||
        n.type === 'Inconsistency' ||
        n.type === 'MergeCandidate' ||
        n.type === 'ExcerptMergeCandidate'
      ) {
        continue;
      }
      nodes.delete(id);
    }
  }

  const elements: ElementDefinition[] = [];
  for (const n of nodes.values()) {
    const mc = mentionCounts.get(n.id) ?? 0;
    elements.push({
      data: {
        id: n.id,
        type: n.type,
        label: nodeLabel(n),
        color:
          n.type === 'PlanStep'
            ? planStepColor(n.props['status'])
            : nodeColor(n.type),
        mentionCount: mc,
      },
      group: 'nodes',
    });
  }
  for (const e of edges.values()) {
    // Drop edges whose endpoints were pruned.
    const d = e.data as { source: string; target: string };
    if (!nodes.has(d.source) || !nodes.has(d.target)) continue;
    elements.push(e);
  }
  return { nodes, mentionCounts, elements };
}

function baseSize(type: NodeType): number {
  switch (type) {
    case 'Session':
      return 52;
    case 'Topic':
      // Cluster head — same prominence as Session so the user-cluster
      // and topic-hubs read symmetric on the canvas.
      return 50;
    case 'Run':
      return 44;
    case 'Turn':
      return 40;
    case 'Inconsistency':
    case 'MergeCandidate':
    case 'ExcerptMergeCandidate':
      // Markers — smaller than MK so they orbit visibly without
      // dominating the canvas.
      return 22;
    case 'AgentInvocation':
      return 36;
    case 'ToolCall':
      return 28;
    case 'OdooEntity':
    case 'ConfluencePage':
      return 26;
    case 'User':
      return 32;
    case 'Plan':
      return 46;
    case 'PlanStep':
      return 30;
    default:
      return 28;
  }
}

function nodeSize(type: NodeType, mentionCount: number): number {
  const b = baseSize(type);
  if (type === 'OdooEntity' || type === 'ConfluencePage') {
    // Entities mentioned more often grow proportionally (capped).
    return b + Math.min(22, Math.log2(mentionCount + 1) * 6);
  }
  return b;
}

function buildLayout(
  nodeCount: number,
  sparse: boolean,
  planRoots?: NodeCollection,
): LayoutOptions {
  const tiny = nodeCount < 50;
  const heavy = nodeCount > 200;
  const huge = nodeCount > 600;
  // #133 — when the canvas is dominated by a plan DAG, lay it out
  // hierarchically rooted at the Plan node(s) instead of fcose's force cloud:
  // the Plan sits on top, its PlanSteps fan out below, and DEPENDS_ON
  // sequencing reads top-down. `breadthfirst` is a cytoscape core layout, so
  // this needs no extra dependency (important given the standalone-bundle
  // fragility this stack has). `directed:false` keeps the layering robust to
  // STEP_OF pointing step→plan (incoming to the root).
  if (planRoots && planRoots.length > 0) {
    return {
      name: 'breadthfirst',
      directed: false,
      roots: planRoots,
      spacingFactor: 1.4,
      padding: 60,
      avoidOverlap: true,
      nodeDimensionsIncludeLabels: true,
      animate: !heavy,
      animationDuration: heavy ? 0 : 400,
      fit: true,
    } as unknown as LayoutOptions;
  }
  // Sparse mode (entity-only default) → spread nodes further so cross-refs
  // and producer-anchors stay visually distinct.
  const repulsionBase = huge ? 6000 : tiny ? 24000 : 10000;
  const lengthBase = huge ? 60 : tiny ? 140 : 90;
  return {
    name: 'fcose',
    animate: !heavy,
    animationDuration: heavy ? 0 : 400,
    randomize: true,
    nodeRepulsion: () => (sparse ? repulsionBase * 1.8 : repulsionBase),
    idealEdgeLength: () => (sparse ? lengthBase * 1.8 : lengthBase),
    nodeSeparation: huge ? 50 : tiny ? 120 : 80,
    gravity: sparse ? 0.05 : tiny ? 0.15 : 0.25,
    gravityRange: tiny ? 5 : 3.8,
    numIter: huge ? 600 : heavy ? 1200 : 2000,
    padding: 50,
    quality: huge ? 'draft' : 'default',
    fit: true,
  } as unknown as LayoutOptions;
}

export default function GraphCanvas({
  session,
  extraSessions = [],
  runs,
  expansions,
  memoryView = null,
  focusMemories = false,
  topicOverlay = null,
  issueOverlay = null,
  planOverlay = null,
  selectedId,
  filter = DEFAULT_FILTER,
  onSelectNode,
  onExpandNode,
  dark = false,
}: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const nodesRef = useRef<Map<string, GraphNode>>(new Map());

  const { nodes, elements } = useMemo(
    () =>
      buildElements(
        session,
        extraSessions,
        runs,
        expansions,
        filter,
        memoryView,
        focusMemories,
        topicOverlay,
        issueOverlay,
        planOverlay,
      ),
    [
      session,
      extraSessions,
      runs,
      expansions,
      filter,
      memoryView,
      focusMemories,
      topicOverlay,
      issueOverlay,
      planOverlay,
    ],
  );
  // Synced via a post-render effect (never during render) to satisfy the
  // React-Compiler `refs` rule; the only reader is the cytoscape `tap` handler,
  // which fires on user clicks long after commit.
  useEffect(() => {
    nodesRef.current = nodes;
  });
  const sparse = !filter.showTrace;
  // #133 — switch to the hierarchical plan-DAG layout only when the canvas is
  // plan-dominated (overlay on + Plan/PlanStep nodes are at least half of all
  // nodes). In mixed views (session + entities + a plan) fcose still wins, so
  // breadthfirst never mangles a graph that isn't mostly a plan.
  const planFocus = useMemo(() => {
    if (!filter.showPlans || nodes.size === 0) return false;
    let planCount = 0;
    for (const n of nodes.values()) {
      if (n.type === 'Plan' || n.type === 'PlanStep') planCount += 1;
    }
    return planCount > 0 && planCount >= nodes.size * 0.5;
  }, [filter.showPlans, nodes]);

  useEffect(() => {
    ensureFcose();
    if (!containerRef.current || cyRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      wheelSensitivity: 0.25,
      minZoom: 0.15,
      maxZoom: 3,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            label: 'data(label)',
            color: dark ? '#e5e7eb' : '#111827',
            'font-size': 11,
            'font-family':
              'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            'text-wrap': 'ellipsis',
            'text-max-width': '140px',
            'text-outline-color': dark ? '#0a0a0a' : '#ffffff',
            'text-outline-width': 2,
            'border-width': 2,
            'border-color': dark ? '#0a0a0a' : '#ffffff',
            width: (ele: NodeSingular) =>
              nodeSize(
                ele.data('type') as NodeType,
                Number(ele.data('mentionCount') ?? 0),
              ),
            height: (ele: NodeSingular) =>
              nodeSize(
                ele.data('type') as NodeType,
                Number(ele.data('mentionCount') ?? 0),
              ),
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-color': '#f43f5e',
            'border-width': 4,
          },
        },
        {
          selector: 'node.faded',
          style: { opacity: 0.25 },
        },
        {
          selector: 'edge',
          style: {
            width: 1,
            'line-color': dark ? '#475569' : '#cbd5e1',
            'target-arrow-color': dark ? '#475569' : '#cbd5e1',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.8,
            'curve-style': 'bezier',
            opacity: 0.55,
          },
        },
        // Domain edges: clearly distinct so real references pop.
        {
          selector: 'edge[label = "PRODUCED"]',
          style: {
            'line-color': '#10b981',
            'target-arrow-color': '#10b981',
            width: 1.8,
            opacity: 0.85,
          },
        },
        {
          selector: 'edge[label = "TRIGGERED"]',
          style: {
            'line-color': '#ec4899',
            'target-arrow-color': '#ec4899',
            width: 1.6,
            opacity: 0.85,
          },
        },
        {
          selector: 'edge[label = "RELATED"]',
          style: {
            'line-color': '#a855f7',
            'target-arrow-color': '#a855f7',
            'line-style': 'dashed',
            width: 1.2,
            opacity: 0.75,
          },
        },
        {
          selector: 'edge[label = "MENTIONS"]',
          style: {
            'line-color': dark ? '#475569' : '#cbd5e1',
            'target-arrow-color': dark ? '#475569' : '#cbd5e1',
            'line-style': 'dotted',
            width: 1,
            opacity: 0.35,
          },
        },
        {
          selector:
            'edge[label = "DERIVED_FROM"], edge[label = "EXCERPT_OF"], edge[label = "INVOLVED"], edge[label = "REQUIRES"], edge[label = "IN_SESSION"]',
          style: {
            'line-color': '#d946ef',
            'target-arrow-color': '#d946ef',
            width: 1.5,
            opacity: 0.85,
          },
        },
        // Trace scaffolding edges fade into the background.
        {
          selector:
            'edge[label = "HAS_TURN"], edge[label = "RAN"], edge[label = "INVOKED"], edge[label = "CALLED"]',
          style: {
            width: 1,
            opacity: 0.4,
          },
        },
        // Slice 11.5 — Topic overlay (HAS_TOPIC) + Issue overlay
        // (CONFLICTS_WITH, DUPLICATE_OF) get their own colours so
        // they read distinctly from the provenance edges.
        {
          selector: 'edge[label = "HAS_TOPIC"]',
          style: {
            'line-color': '#14b8a6',
            'target-arrow-color': '#14b8a6',
            opacity: 0.7,
          },
        },
        {
          // Inferred Excerpt → Topic via parent-MK transitivity. Dotted
          // + thinner so it reads as weaker than the real HAS_TOPIC.
          selector: 'edge[label = "HAS_TOPIC_INDIRECT"]',
          style: {
            'line-color': '#14b8a6',
            'target-arrow-color': '#14b8a6',
            'line-style': 'dotted',
            width: 1,
            opacity: 0.45,
          },
        },
        {
          selector: 'edge[label = "CONFLICTS_WITH"]',
          style: {
            'line-color': '#ef4444',
            'target-arrow-color': '#ef4444',
            'line-style': 'dashed',
            opacity: 0.85,
          },
        },
        {
          selector: 'edge[label = "DUPLICATE_OF"]',
          style: {
            'line-color': '#f97316',
            'target-arrow-color': '#f97316',
            'line-style': 'dashed',
            opacity: 0.85,
          },
        },
        {
          // Slice 12.5 — Excerpt-side duplicates use the lighter shade so
          // they read as the Excerpt-layer mirror of DUPLICATE_OF.
          selector: 'edge[label = "DUPLICATE_EXCERPT_OF"]',
          style: {
            'line-color': '#fb923c',
            'target-arrow-color': '#fb923c',
            'line-style': 'dashed',
            opacity: 0.85,
          },
        },
        // #133 — Plan DAG edges. STEP_OF is structural membership
        // (step → plan): faded + dotted so it recedes. DEPENDS_ON is the
        // step-to-prerequisite sequencing the breadthfirst layout follows:
        // solid indigo with a prominent arrow so the flow reads as primary.
        {
          selector: 'edge[label = "STEP_OF"]',
          style: {
            'line-color': '#a78bfa',
            'target-arrow-color': '#a78bfa',
            'line-style': 'dotted',
            width: 1,
            opacity: 0.45,
          },
        },
        {
          selector: 'edge[label = "DEPENDS_ON"]',
          style: {
            'line-color': '#6366f1',
            'target-arrow-color': '#6366f1',
            width: 1.8,
            'arrow-scale': 1,
            opacity: 0.9,
          },
        },
        {
          selector: 'edge.faded',
          style: { opacity: 0.08 },
        },
        {
          selector: 'edge.highlighted',
          style: {
            'line-color': '#f43f5e',
            'target-arrow-color': '#f43f5e',
            width: 2.5,
            opacity: 1,
          },
        },
      ],
    });

    cy.on('tap', 'node', (evt: EventObject) => {
      const id = String(evt.target.id());
      const node = nodesRef.current.get(id);
      if (node) onSelectNode(node);
    });

    cy.on('dbltap', 'node', (evt: EventObject) => {
      onExpandNode(String(evt.target.id()));
    });

    cy.on('tap', (evt: EventObject) => {
      if (evt.target === cy) onSelectNode(null);
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Incremental update + debounced re-layout. Avoids running fcose on every
  // single session-view arrival when '🌐 Alle' streams in progressively.
  const layoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutedOnce = useRef(false);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const incomingIds = new Set(
      elements.map((e) => String((e.data as { id: string }).id)),
    );
    const toRemove = cy.elements().filter((el) => !incomingIds.has(String(el.id())));
    const existing = new Set(cy.elements().map((el) => String(el.id())));
    const additions = elements.filter(
      (e) => !existing.has(String((e.data as { id: string }).id)),
    );

    cy.batch(() => {
      if (toRemove.length > 0) toRemove.remove();
      if (additions.length > 0) cy.add(additions);
    });

    if (elements.length === 0) {
      layoutedOnce.current = false;
      return;
    }

    if (layoutTimer.current) clearTimeout(layoutTimer.current);
    const isFirst = !layoutedOnce.current;
    // Run immediately on first population, debounce subsequent deltas so rapid
    // streams coalesce into a single layout pass.
    const delay = isFirst ? 0 : 400;
    layoutTimer.current = setTimeout(() => {
      const count = cy.nodes().length;
      if (count === 0) return;
      const roots = planFocus ? cy.nodes('[type = "Plan"]') : undefined;
      const layout = cy.layout(buildLayout(count, sparse, roots));
      layout.run();
      layoutedOnce.current = true;
    }, delay);

    return () => {
      if (layoutTimer.current) clearTimeout(layoutTimer.current);
    };
  }, [elements, sparse, planFocus]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass('faded highlighted');
    if (!selectedId) {
      cy.nodes().unselect();
      return;
    }
    const target = cy.getElementById(selectedId);
    if (target.empty()) return;
    cy.nodes().unselect();
    target.select();
    const neighborhood = target.closedNeighborhood();
    cy.elements().not(neighborhood).addClass('faded');
    target.connectedEdges().addClass('highlighted');
  }, [selectedId]);

  const fit = (): void => {
    cyRef.current?.animate({ fit: { eles: cyRef.current.elements(), padding: 40 }, duration: 300 });
  };
  const zoomIn = (): void => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * 1.25, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const zoomOut = (): void => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() / 1.25, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const relayout = (): void => {
    const cy = cyRef.current;
    if (!cy) return;
    const count = cy.nodes().length;
    if (count === 0) return;
    const roots = planFocus ? cy.nodes('[type = "Plan"]') : undefined;
    cy.layout(buildLayout(count, sparse, roots)).run();
  };

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{
          background: dark
            ? 'radial-gradient(circle at 30% 20%, #111827 0%, #0a0a0a 70%)'
            : 'radial-gradient(circle at 30% 20%, #ffffff 0%, #f1f5f9 70%)',
        }}
      />
      <div className="pointer-events-none absolute inset-0 flex items-start justify-between p-3">
        <Legend dark={dark} filter={filter} />
        <div className="pointer-events-auto flex flex-col gap-1.5 rounded-lg border border-neutral-200 bg-white/90 p-1.5 shadow-sm backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/80">
          <IconBtn title="Zoom in" onClick={zoomIn}>＋</IconBtn>
          <IconBtn title="Zoom out" onClick={zoomOut}>−</IconBtn>
          <IconBtn title="Fit" onClick={fit}>⤢</IconBtn>
          <IconBtn title="Re-Layout" onClick={relayout}>↻</IconBtn>
        </div>
      </div>
      {elements.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
          keine Knoten — Session links wählen oder Filter anpassen
        </div>
      )}
      <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-neutral-500">
        Klick = Auswählen · Doppelklick = Nachbarn laden · Rad = Zoom · Ziehen = Pan
      </div>
    </div>
  );
}

function IconBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded font-mono text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {children}
    </button>
  );
}

function Legend({
  dark,
  filter,
}: {
  dark: boolean;
  filter: GraphFilter;
}): React.ReactElement {
  const items: Array<[NodeType, string]> = [
    ['Session', 'Session'],
    ['User', 'User'],
  ];
  if (filter.showEntities) {
    items.push(['OdooEntity', 'Odoo'], ['ConfluencePage', 'Confluence']);
  }
  if (filter.showTrace) {
    items.push(
      ['Turn', 'Turn'],
      ['Run', 'Run'],
      ['AgentInvocation', 'Agent'],
      ['ToolCall', 'Tool'],
    );
  }
  if (filter.showMemories) {
    items.push(['MemorableKnowledge', 'Memory'], ['PalaiaExcerpt', 'Excerpt']);
  }
  if (filter.showTopics) {
    items.push(['Topic', 'Topic-Cluster']);
  }
  if (filter.showIssues) {
    items.push(
      ['Inconsistency', 'Konflikt'],
      ['MergeCandidate', 'Duplikat-Kandidat'],
      ['ExcerptMergeCandidate', 'Excerpt-Duplikat'],
    );
  }
  if (filter.showPlans) {
    items.push(['Plan', 'Plan'], ['PlanStep', 'Plan-Schritt']);
  }
  const edgeRows: Array<[string, string]> = [['#10b981', 'PRODUCED']];
  edgeRows.push(['#ec4899', 'TRIGGERED']);
  if (filter.showCrossRefs) edgeRows.push(['#a855f7', 'RELATED']);
  if (filter.showMentions) edgeRows.push(['#94a3b8', 'MENTIONS']);
  if (filter.showMemories)
    edgeRows.push(['#d946ef', 'Provenance (DERIVED · EXCERPT · …)']);
  if (filter.showTopics) {
    edgeRows.push(['#14b8a6', 'HAS_TOPIC']);
    edgeRows.push(['#14b8a6', 'HAS_TOPIC (Excerpt, transitiv)']);
  }
  if (filter.showIssues) {
    edgeRows.push(['#ef4444', 'CONFLICTS_WITH']);
    edgeRows.push(['#f97316', 'DUPLICATE_OF (MK)']);
    edgeRows.push(['#fb923c', 'DUPLICATE_EXCERPT_OF']);
  }
  if (filter.showPlans) {
    edgeRows.push(['#a78bfa', 'STEP_OF']);
    edgeRows.push(['#6366f1', 'DEPENDS_ON']);
  }

  return (
    <div
      className={[
        'pointer-events-auto flex flex-col gap-1 rounded-lg border px-2 py-1.5 text-[10px] shadow-sm backdrop-blur',
        dark
          ? 'border-neutral-700 bg-neutral-900/80 text-neutral-300'
          : 'border-neutral-200 bg-white/90 text-neutral-600',
      ].join(' ')}
    >
      {items.map(([t, label]) => (
        <div key={t} className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: nodeColor(t) }}
          />
          <span>{label}</span>
        </div>
      ))}
      <div className="my-1 h-px bg-neutral-300/50 dark:bg-neutral-700/60" />
      {edgeRows.map(([color, label]) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className="h-0.5 w-3 rounded"
            style={{ backgroundColor: color }}
          />
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
