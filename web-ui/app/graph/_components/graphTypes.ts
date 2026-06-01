export type NodeType =
  | 'Session'
  | 'Turn'
  | 'OdooEntity'
  | 'ConfluencePage'
  | 'PluginEntity'
  | 'User'
  | 'ChannelIdentity'
  | 'Run'
  | 'AgentInvocation'
  | 'ToolCall'
  | 'Fact'
  | 'MemorableKnowledge'
  /** Slice 6.5 — verbatim source-snippet that underpins a
   *  MemorableKnowledge. Reachable via EXCERPT_OF edges from MK's
   *  "Nachbarn expandieren" expansion. */
  | 'PalaiaExcerpt'
  /** Slice 9 — contradiction marker between two MKs. Reachable via
   *  CONFLICTS_WITH edges. Loaded explicitly via /dev/graph/issues
   *  (showIssues filter) — not part of /neighbors expansions. */
  | 'Inconsistency'
  /** Slice 10 — near-duplicate marker (cosine ≥ 0.95) between two MKs.
   *  Reachable via DUPLICATE_OF edges. Same load path as Inconsistency. */
  | 'MergeCandidate'
  /** Slice 12 — near-duplicate marker (cosine ≥ 0.97) between two
   *  PalaiaExcerpts. Reachable via DUPLICATE_EXCERPT_OF edges. Same load
   *  path as MergeCandidate (Issue-Overlay). */
  | 'ExcerptMergeCandidate'
  /** Slice 11 — clustered group of MKs named by Haiku. Reachable via
   *  HAS_TOPIC edges. Loaded via /dev/graph/topics (showTopics filter). */
  | 'Topic'
  /** #133 plan-as-data — per-turn plan DAG root + its typed sub-goal steps.
   *  Loaded via /dev/graph/plans (showPlans filter). PlanStep lifecycle is in
   *  props.status (pending|in_progress|done|failed|skipped); steps link to the
   *  Plan via STEP_OF and to each other via DEPENDS_ON. */
  | 'Plan'
  | 'PlanStep';

/** Lifecycle bucket projected by the Neon backend (palaia Phase 4). */
export type Tier = 'HOT' | 'WARM' | 'COLD';
/** Memory-Klassifikation (palaia Phase 1). */
export type EntryType = 'memory' | 'process' | 'task';

export interface GraphNode {
  id: string;
  type: NodeType;
  props: Record<string, unknown>;
  // Palaia fields surfaced by the middleware. Optional — non-Turn nodes
  // typically carry the DB defaults but the UI only renders the badges
  // for Turn nodes.
  entryType?: EntryType;
  tier?: Tier;
  accessedAt?: string | null;
  accessCount?: number;
  decayScore?: number;
  manuallyAuthored?: boolean;
  significance?: number | null;
}

export interface SessionSummary {
  id: string;
  scope: string;
  turnCount: number;
  firstAt: string;
  lastAt: string;
}

export interface SessionView {
  session: GraphNode;
  turns: Array<{ turn: GraphNode; entities: GraphNode[] }>;
  /** Slice 1b-channel-web — User-Cluster the session belongs to.
   *  Backend resolves it via `session.props.userId`; the canvas adds
   *  the User node + a synthetic `BELONGS_TO` edge to the session. */
  user?: GraphNode;
}

export interface RunToolCallView {
  node: GraphNode;
  producedEntities: GraphNode[];
}

export interface RunAgentInvocationView {
  node: GraphNode;
  toolCalls: RunToolCallView[];
}

export interface RunTraceView {
  turn: GraphNode;
  run: GraphNode;
  user?: GraphNode;
  orchestratorToolCalls: RunToolCallView[];
  agentInvocations: RunAgentInvocationView[];
}

export interface Stats {
  nodes: number;
  edges: number;
  byNodeType: Record<string, number>;
  byEdgeType: Record<string, number>;
}

/**
 * Memory Focused View payload from `GET /bot-api/dev/graph/memories`.
 * Each memory carries the 2-hop provenance ancestors the dedicated tab
 * needs to render the canvas without further /neighbors round-trips.
 *
 * Provenance chain:
 *   `PalaiaExcerpt -EXCERPT_OF-> MK -DERIVED_FROM-> Turn -IN_SESSION-> Session`
 *   `MK -INVOLVED-> User`, `MK -REQUIRES-> Entity`
 */
export interface MemoryWithAncestors {
  node: GraphNode;
  level1: GraphNode[];
  level2: GraphNode[];
}

/** Real graph_edges row connecting the memory subgraph. */
export interface MemoryProvenanceEdge {
  from: string;
  to: string;
  type:
    | 'DERIVED_FROM'
    | 'INVOLVED'
    | 'REQUIRES'
    | 'IN_SESSION'
    | 'EXCERPT_OF';
}

/** Slice 11.5 — payload from `GET /bot-api/dev/graph/topics`. */
export interface TopicOverlay {
  topics: GraphNode[];
  edges: Array<{ from: string; to: string }>;
}

/** Slice 11.5 + 12.5 — payload from `GET /bot-api/dev/graph/issues`. */
export interface IssueOverlay {
  inconsistencies: GraphNode[];
  mergeCandidates: GraphNode[];
  /** Slice 12.5 — near-duplicate Excerpt markers. Same overlay-toggle
   *  (`showIssues`) as the other two — operator-mental-model is "alle
   *  Duplikat-/Konflikt-Marker im Tenant". */
  excerptMergeCandidates: GraphNode[];
  edges: Array<{
    from: string;
    to: string;
    type: 'CONFLICTS_WITH' | 'DUPLICATE_OF' | 'DUPLICATE_EXCERPT_OF';
  }>;
}

export interface MemoryView {
  scope: string;
  memories: MemoryWithAncestors[];
  edges: MemoryProvenanceEdge[];
}

/** #133 — payload from `GET /bot-api/dev/graph/plans?scope=`. Each entry is a
 *  per-turn Plan node plus its ordered PlanSteps (status/dependsOn in props). */
export interface PlanOverlay {
  scope: string;
  plans: Array<{ plan: GraphNode; steps: GraphNode[] }>;
}

/**
 * Visibility filter for the Cytoscape canvas. The persistence layer is
 * unchanged — these toggles only control what is rendered.
 *
 * - entities:  OdooEntity / ConfluencePage (Users always shown when present)
 * - trace:     Turn / Run / AgentInvocation / ToolCall scaffolding
 * - mentions:  aggregated Session→Entity reference edges (one per pair)
 * - crossRefs: RELATED edges from /neighbors expansions
 */
export interface GraphFilter {
  showEntities: boolean;
  showTrace: boolean;
  showMentions: boolean;
  showCrossRefs: boolean;
  /** Slice — Palaia Focused View. When true, the canvas additionally
   *  renders MemorableKnowledge + PalaiaExcerpt nodes loaded via
   *  `/dev/graph/memories`, along with their 2-hop provenance edges. */
  showMemories: boolean;
  /** Slice 11.5 — when true, the canvas overlays every Topic node + its
   *  HAS_TOPIC edges, loaded via `/dev/graph/topics`. Independent of
   *  showMemories. */
  showTopics: boolean;
  /** Slice 11.5 — when true, the canvas overlays Inconsistency +
   *  MergeCandidate nodes + their CONFLICTS_WITH / DUPLICATE_OF edges,
   *  loaded via `/dev/graph/issues`. */
  showIssues: boolean;
  /** #133 — when true, the canvas overlays the selected session's per-turn
   *  plan DAGs (Plan + PlanStep nodes + STEP_OF / DEPENDS_ON edges), loaded
   *  via `/dev/graph/plans?scope=`. Requires a concrete session selection. */
  showPlans: boolean;
}

export const DEFAULT_FILTER: GraphFilter = {
  showEntities: true,
  showTrace: false,
  showMentions: false,
  showCrossRefs: true,
  showMemories: false,
  showTopics: false,
  showIssues: false,
  showPlans: false,
};

export const TRACE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'Turn',
  'Run',
  'AgentInvocation',
  'ToolCall',
]);

export function nodeLabel(n: GraphNode): string {
  const p = n.props;
  const display = p['displayName'] ?? p['agentName'] ?? p['toolName'];
  if (display !== undefined) return String(display);
  if (n.type === 'Turn') {
    const msg = String(p['userMessage'] ?? '');
    return msg.length > 40 ? `${msg.slice(0, 40)}…` : msg || 'Turn';
  }
  if (n.type === 'Session') return String(p['scope'] ?? n.id);
  if (n.type === 'User') return String(p['userId'] ?? n.id);
  if (n.type === 'Run') return `Run · ${String(p['status'] ?? '')}`;
  if (n.type === 'PalaiaExcerpt') {
    const text = String(p['text'] ?? '');
    return text.length > 40 ? `${text.slice(0, 40)}…` : text || 'Excerpt';
  }
  if (n.type === 'MemorableKnowledge') {
    const summary = String(p['summary'] ?? '');
    return summary.length > 40 ? `${summary.slice(0, 40)}…` : summary || 'Memory';
  }
  if (n.type === 'Topic') {
    const name = String(p['name'] ?? '');
    const count =
      typeof p['member_count'] === 'number'
        ? ` (${String(p['member_count'])})`
        : '';
    return name.length > 40 ? `${name.slice(0, 40)}…${count}` : `${name}${count}` || 'Topic';
  }
  if (n.type === 'Inconsistency') {
    const summary = String(p['summary'] ?? '');
    const sev = p['severity'] ? `[${String(p['severity'])}] ` : '';
    return summary.length > 36
      ? `${sev}${summary.slice(0, 36)}…`
      : `${sev}${summary}` || 'Inconsistency';
  }
  if (n.type === 'MergeCandidate') {
    const cos =
      typeof p['cosine_sim'] === 'number'
        ? Number(p['cosine_sim']).toFixed(2)
        : '?';
    return `dup? cos=${cos}`;
  }
  if (n.type === 'ExcerptMergeCandidate') {
    const cos =
      typeof p['cosine_sim'] === 'number'
        ? Number(p['cosine_sim']).toFixed(2)
        : '?';
    return `excerpt-dup? cos=${cos}`;
  }
  if (n.type === 'Plan') {
    const strat = String(p['strategy'] ?? '');
    return strat ? `Plan · ${strat}` : 'Plan';
  }
  if (n.type === 'PlanStep') {
    const ord = p['order'];
    const prefix = typeof ord === 'number' ? `${String(ord + 1)}. ` : '';
    const goal = String(p['goal'] ?? '');
    const g = goal.length > 36 ? `${goal.slice(0, 36)}…` : goal;
    return `${prefix}${g}` || 'Step';
  }
  return n.id;
}

/**
 * #133 — PlanStep node colour by lifecycle status (`props.status`). Used by
 * the canvas to colour steps as they progress; falls back to violet (pending).
 */
export function planStepColor(status: unknown): string {
  switch (status) {
    case 'done':
      return '#22c55e'; // green
    case 'in_progress':
      return '#3b82f6'; // blue
    case 'failed':
      return '#ef4444'; // red
    case 'skipped':
      return '#94a3b8'; // grey
    case 'pending':
    default:
      return '#a78bfa'; // violet
  }
}

export function nodeColor(type: NodeType): string {
  switch (type) {
    case 'Session':
      return '#a855f7';
    case 'Turn':
      return '#64748b';
    case 'Run':
      return '#6366f1';
    case 'AgentInvocation':
      return '#06b6d4';
    case 'ToolCall':
      return '#f59e0b';
    case 'OdooEntity':
      return '#10b981';
    case 'ConfluencePage':
      return '#3b82f6';
    case 'PluginEntity':
      return '#22c55e';
    case 'User':
      return '#ec4899';
    case 'ChannelIdentity':
      return '#14b8a6';
    case 'Fact':
      return '#fbbf24';
    case 'MemorableKnowledge':
      return '#d946ef';
    case 'PalaiaExcerpt':
      return '#0ea5e9';
    case 'Topic':
      // Teal — pops against the existing palette without clashing with
      // ChannelIdentity (same family) because nodes sit in different
      // canvas regions.
      return '#14b8a6';
    case 'Inconsistency':
      return '#ef4444';
    case 'MergeCandidate':
      return '#f97316';
    case 'ExcerptMergeCandidate':
      // Same orange hue as MergeCandidate but a lighter shade
      // (Tailwind orange-400 vs orange-500) so operators distinguish the
      // Excerpt-side marker at a glance without breaking the shared
      // "orange = duplicate" mental model.
      return '#fb923c';
    case 'Plan':
      return '#8b5cf6'; // violet — plan DAG root
    case 'PlanStep':
      // Default step colour; the canvas overrides per-step from props.status
      // via planStepColor(). This is the fallback when status is absent.
      return '#a78bfa';
    default:
      return '#94a3b8';
  }
}

export function mergeSessionViews(views: SessionView[]): SessionView | null {
  if (views.length === 0) return null;
  return {
    session: {
      id: '__ALL__',
      type: 'Session',
      props: { scope: '__ALL__', merged: views.length },
    },
    turns: views.flatMap((v) =>
      v.turns.map((t) => ({ turn: t.turn, entities: t.entities })),
    ),
  };
}

/**
 * Minimal concurrency-limited task runner. Prevents tens of in-flight fetches
 * from flooding the middleware when entering '🌐 Alle Sessions' mode.
 */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    if (active >= concurrency) return;
    const task = queue.shift();
    if (task) task();
  };
  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

export function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso.slice(0, 16).replace('T', ' ');
  const diff = Date.now() - then;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `vor ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `vor ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `vor ${d}d`;
  return iso.slice(0, 10);
}

export function nodeIcon(type: NodeType): string {
  switch (type) {
    case 'Session':
      return '📂';
    case 'Turn':
      return '💬';
    case 'OdooEntity':
      return '🏷';
    case 'ConfluencePage':
      return '📄';
    case 'PluginEntity':
      return '🔌';
    case 'User':
      return '👤';
    case 'ChannelIdentity':
      return '📡';
    case 'Run':
      return '▶';
    case 'AgentInvocation':
      return '🤖';
    case 'ToolCall':
      return '🔧';
    case 'Fact':
      return '✦';
    case 'MemorableKnowledge':
      return '⭐';
    case 'PalaiaExcerpt':
      return '❝';
    case 'Topic':
      return '🧩';
    case 'Inconsistency':
      return '⚠';
    case 'MergeCandidate':
      return '⇄';
    case 'ExcerptMergeCandidate':
      return '⇄';
    case 'Plan':
      return '🗺';
    case 'PlanStep':
      return '◻';
    default:
      return '•';
  }
}
