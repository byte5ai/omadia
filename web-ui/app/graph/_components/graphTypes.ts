export type NodeType =
  | 'Session'
  | 'Turn'
  | 'OdooEntity'
  | 'ConfluencePage'
  | 'User'
  | 'Run'
  | 'AgentInvocation'
  | 'ToolCall';

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
}

export const DEFAULT_FILTER: GraphFilter = {
  showEntities: true,
  showTrace: false,
  showMentions: false,
  showCrossRefs: true,
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
  return n.id;
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
    case 'User':
      return '#ec4899';
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
    case 'User':
      return '👤';
    case 'Run':
      return '▶';
    case 'AgentInvocation':
      return '🤖';
    case 'ToolCall':
      return '🔧';
    default:
      return '•';
  }
}
