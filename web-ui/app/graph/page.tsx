'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ListView from './_components/ListView';
import DetailPanel from './_components/DetailPanel';
import {
  DEFAULT_FILTER,
  type GraphFilter,
  type GraphNode,
  type RunTraceView,
  type SessionSummary,
  type SessionView,
  type Stats,
  createLimiter,
  relativeTime,
} from './_components/graphTypes';

// Shared across the page lifetime: at most 4 concurrent /session fetches.
const sessionFetchLimit = createLimiter(4);

const GraphCanvas = dynamic(() => import('./_components/GraphCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
      lade Graph-Canvas…
    </div>
  ),
});

type ViewMode = 'graph' | 'list';

const ALL = '__ALL__';

export default function GraphPage(): React.ReactElement {
  const [mode, setMode] = useState<ViewMode>('graph');
  const [stats, setStats] = useState<Stats | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string>(ALL);
  const [sessionViews, setSessionViews] = useState<
    Record<string, SessionView | 'loading' | 'missing'>
  >({});
  const [runCache, setRunCache] = useState<
    Record<string, RunTraceView | 'loading' | 'missing'>
  >({});
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [neighborsByNode, setNeighborsByNode] = useState<
    Record<string, GraphNode[] | 'loading'>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [dark, setDark] = useState(false);
  const [filter, setFilter] = useState('');
  const [graphFilter, setGraphFilter] = useState<GraphFilter>(DEFAULT_FILTER);
  const toggleFilter = (key: keyof GraphFilter): void =>
    setGraphFilter((prev) => ({ ...prev, [key]: !prev[key] }));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    setDark(mql.matches);
    const handler = (e: MediaQueryListEvent): void => setDark(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [statsRes, sessionsRes] = await Promise.all([
        fetch('/bot-api/dev/graph/stats'),
        fetch('/bot-api/dev/graph/sessions'),
      ]);
      if (statsRes.status === 404 || sessionsRes.status === 404) {
        setError(
          'Dev-Graph-Endpoint nicht verfügbar. Setze DEV_ENDPOINTS_ENABLED=true in middleware/.env.',
        );
        return;
      }
      if (!statsRes.ok || !sessionsRes.ok) {
        setError(
          `Graph-Load fehlgeschlagen (stats=${String(statsRes.status)}, sessions=${String(sessionsRes.status)})`,
        );
        return;
      }
      setStats((await statsRes.json()) as Stats);
      const body = (await sessionsRes.json()) as { sessions: SessionSummary[] };
      setSessions(body.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadSessionView = useCallback(
    async (scope: string): Promise<SessionView | null> => {
      const cached = sessionViews[scope];
      if (cached && cached !== 'loading' && cached !== 'missing') return cached;
      if (cached === 'loading') return null;
      setSessionViews((p) => ({ ...p, [scope]: 'loading' }));
      return sessionFetchLimit(async () => {
        try {
          const res = await fetch(
            `/bot-api/dev/graph/session/${encodeURIComponent(scope)}`,
          );
          if (!res.ok) {
            setSessionViews((p) => ({ ...p, [scope]: 'missing' }));
            return null;
          }
          const body = (await res.json()) as SessionView;
          setSessionViews((p) => ({ ...p, [scope]: body }));
          return body;
        } catch {
          setSessionViews((p) => ({ ...p, [scope]: 'missing' }));
          return null;
        }
      });
    },
    [sessionViews],
  );

  // Load the active session's own view on demand.
  useEffect(() => {
    if (selected === ALL) return;
    if (!sessionViews[selected]) void loadSessionView(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // In 'Alle' mode only: load all session views (throttled to 4 concurrent).
  useEffect(() => {
    if (selected !== ALL) return;
    for (const s of sessions) {
      if (!sessionViews[s.scope]) void loadSessionView(s.scope);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, sessions]);

  const loadRun = useCallback(
    async (turnId: string): Promise<void> => {
      if (runCache[turnId] && runCache[turnId] !== 'missing') return;
      setRunCache((prev) => ({ ...prev, [turnId]: 'loading' }));
      try {
        const res = await fetch(
          `/bot-api/dev/graph/run?turnId=${encodeURIComponent(turnId)}`,
        );
        if (!res.ok) {
          setRunCache((prev) => ({ ...prev, [turnId]: 'missing' }));
          return;
        }
        const body = (await res.json()) as RunTraceView;
        setRunCache((prev) => ({ ...prev, [turnId]: body }));
      } catch {
        setRunCache((prev) => ({ ...prev, [turnId]: 'missing' }));
      }
    },
    [runCache],
  );

  // In single-session graph mode, auto-load runs for all turns.
  useEffect(() => {
    if (mode !== 'graph' || selected === ALL) return;
    const view = sessionViews[selected];
    if (!view || view === 'loading' || view === 'missing') return;
    for (const t of view.turns) {
      if (!runCache[t.turn.id]) void loadRun(t.turn.id);
    }
  }, [mode, selected, sessionViews, runCache, loadRun]);

  const loadNeighbors = useCallback(
    async (nodeId: string): Promise<void> => {
      if (neighborsByNode[nodeId] && neighborsByNode[nodeId] !== 'loading')
        return;
      setNeighborsByNode((prev) => ({ ...prev, [nodeId]: 'loading' }));
      try {
        const res = await fetch(
          `/bot-api/dev/graph/neighbors?nodeId=${encodeURIComponent(nodeId)}`,
        );
        if (!res.ok) {
          setNeighborsByNode((prev) => ({ ...prev, [nodeId]: [] }));
          return;
        }
        const body = (await res.json()) as {
          nodeId: string;
          neighbors: GraphNode[];
        };
        setNeighborsByNode((prev) => ({ ...prev, [nodeId]: body.neighbors }));
      } catch {
        setNeighborsByNode((prev) => ({ ...prev, [nodeId]: [] }));
      }
    },
    [neighborsByNode],
  );

  const handleGraphNodeExpand = (nodeId: string): void => {
    const node = findNodeInState(nodeId, sessionViews, runCache, neighborsByNode);
    if (node?.type === 'Turn') void loadRun(nodeId);
    void loadNeighbors(nodeId);
  };

  const handleEntityClickFromList = (id: string): void => {
    void loadNeighbors(id);
    setMode('graph');
    const node = findNodeInState(id, sessionViews, runCache, neighborsByNode);
    if (node) setSelectedNode(node);
  };

  const expansionList = useMemo(
    () =>
      Object.entries(neighborsByNode)
        .filter(([, v]) => Array.isArray(v))
        .map(([source, neighbors]) => ({
          source,
          neighbors: neighbors as GraphNode[],
        })),
    [neighborsByNode],
  );

  const runsLoaded = useMemo(() => {
    const out: Record<string, RunTraceView> = {};
    for (const [k, v] of Object.entries(runCache)) {
      if (v && v !== 'loading' && v !== 'missing') out[k] = v;
    }
    return out;
  }, [runCache]);

  const activeView: SessionView | null = useMemo(() => {
    if (selected === ALL) return null;
    const v = sessionViews[selected];
    if (!v || v === 'loading' || v === 'missing') return null;
    return v;
  }, [selected, sessionViews]);

  const allViews: SessionView[] = useMemo(() => {
    if (selected !== ALL) return [];
    return sessions
      .map((s) => sessionViews[s.scope])
      .filter(
        (v): v is SessionView => !!v && v !== 'loading' && v !== 'missing',
      );
  }, [selected, sessions, sessionViews]);

  const allLoadedCount = allViews.length;
  const allTotal = sessions.length;
  const loadingAll =
    selected === ALL && allLoadedCount < allTotal && allTotal > 0;

  const filteredSessions = useMemo(() => {
    if (!filter.trim()) return sessions;
    const q = filter.toLowerCase();
    return sessions.filter((s) => {
      if (s.scope.toLowerCase().includes(q)) return true;
      const sv = sessionViews[s.scope];
      if (!sv || sv === 'loading' || sv === 'missing') return false;
      return sv.turns.some((t) =>
        String(t.turn.props['userMessage'] ?? '')
          .toLowerCase()
          .includes(q),
      );
    });
  }, [sessions, filter, sessionViews]);

  const neighborsForSelected =
    selectedNode && neighborsByNode[selectedNode.id]
      ? neighborsByNode[selectedNode.id]
      : undefined;

  const headerTitle =
    selected === ALL
      ? `🌐 Alle Sessions (${allLoadedCount}/${allTotal})`
      : (activeView?.session.id ?? selected);

  const turnSum =
    selected === ALL
      ? allViews.reduce((acc, v) => acc + v.turns.length, 0)
      : (activeView?.turns.length ?? 0);

  return (
    <main className="flex h-full">
      <aside className="flex w-80 min-w-0 flex-col border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="border-b border-neutral-200 px-3 py-3 text-xs dark:border-neutral-800">
          <div className="mb-1 font-semibold">Graph</div>
          {stats && (
            <div className="space-y-0.5 font-mono text-[11px] text-neutral-500">
              <div>
                nodes={stats.nodes} · edges={stats.edges}
              </div>
              <div>
                Session={stats.byNodeType['Session'] ?? 0} · Turn=
                {stats.byNodeType['Turn'] ?? 0}
              </div>
              <div>
                Odoo={stats.byNodeType['OdooEntity'] ?? 0} · Confluence=
                {stats.byNodeType['ConfluencePage'] ?? 0}
              </div>
              <div>
                Run={stats.byNodeType['Run'] ?? 0} · Agent=
                {stats.byNodeType['AgentInvocation'] ?? 0} · Tool=
                {stats.byNodeType['ToolCall'] ?? 0}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-2 text-[11px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ↻ neu laden
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            setSelected(ALL);
            setSelectedNode(null);
          }}
          className={[
            'mx-2 my-2 flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition',
            selected === ALL
              ? 'border-purple-400 bg-purple-50 text-purple-900 dark:border-purple-700 dark:bg-purple-900/30 dark:text-purple-100'
              : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500',
          ].join(' ')}
        >
          <span className="text-base">🌐</span>
          <span className="flex flex-col">
            <span className="font-semibold">Alle Sessions</span>
            <span className="text-[10px] text-neutral-500">
              Gesamte Wolke · {allTotal} Sessions
            </span>
          </span>
        </button>

        <div className="mx-2 mb-2">
          <input
            type="text"
            placeholder="Sessions filtern…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full rounded border border-neutral-200 bg-white px-2 py-1 text-xs outline-none placeholder:text-neutral-400 focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:focus:border-neutral-500"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            <span>
              Sessions ({filteredSessions.length}
              {filter ? `/${sessions.length}` : ''})
            </span>
          </div>
          {error && (
            <div className="border-l-2 border-red-400 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
          {sessions.length === 0 && !error && (
            <div className="px-3 py-2 text-xs text-neutral-500">
              keine — stell eine Frage im Chat
            </div>
          )}
          {filteredSessions.map((s) => (
            <SessionCard
              key={s.id}
              summary={s}
              view={sessionViews[s.scope]}
              active={s.scope === selected}
              onClick={() => {
                setSelected(s.scope);
                setSelectedNode(null);
              }}
            />
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-neutral-50 dark:bg-neutral-950">
        <div className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <span className="truncate font-mono text-neutral-600 dark:text-neutral-400">
            {headerTitle}
          </span>
          <span className="text-[11px] text-neutral-500">
            {turnSum} Turn{turnSum === 1 ? '' : 's'}
            {loadingAll ? ' · lade…' : ''}
          </span>
          {mode === 'graph' && (
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <FilterChip
                label="Entitäten"
                hint="Odoo · Confluence"
                active={graphFilter.showEntities}
                onClick={() => toggleFilter('showEntities')}
                tone="emerald"
              />
              <FilterChip
                label="Cross-Refs"
                hint="RELATED · expandiert"
                active={graphFilter.showCrossRefs}
                onClick={() => toggleFilter('showCrossRefs')}
                tone="purple"
              />
              <FilterChip
                label="Mentions"
                hint="aggregiert pro Session"
                active={graphFilter.showMentions}
                onClick={() => toggleFilter('showMentions')}
                tone="slate"
              />
              <FilterChip
                label="Trace"
                hint="Turn · Run · Agent · Tool"
                active={graphFilter.showTrace}
                onClick={() => toggleFilter('showTrace')}
                tone="amber"
              />
            </div>
          )}
          <div
            className={[
              'inline-flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700',
              mode === 'graph' ? '' : 'ml-auto',
            ].join(' ')}
          >
            <ModeBtn
              active={mode === 'graph'}
              onClick={() => setMode('graph')}
              label="Graph"
            />
            <ModeBtn
              active={mode === 'list'}
              onClick={() => setMode('list')}
              label="Liste"
              disabled={selected === ALL}
            />
          </div>
        </div>

        {selected === ALL ? (
          <div className="min-h-0 flex-1">
            <GraphCanvas
              session={null}
              extraSessions={allViews}
              runs={{}}
              expansions={expansionList}
              selectedId={selectedNode?.id ?? null}
              filter={graphFilter}
              onSelectNode={setSelectedNode}
              onExpandNode={handleGraphNodeExpand}
              dark={dark}
            />
          </div>
        ) : !activeView ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            lade Session…
          </div>
        ) : mode === 'graph' ? (
          <div className="min-h-0 flex-1">
            <GraphCanvas
              session={activeView}
              runs={runsLoaded}
              expansions={expansionList}
              selectedId={selectedNode?.id ?? null}
              filter={graphFilter}
              onSelectNode={setSelectedNode}
              onExpandNode={handleGraphNodeExpand}
              dark={dark}
            />
          </div>
        ) : (
          <ListView
            view={activeView}
            runCache={runCache}
            onEntityClick={handleEntityClickFromList}
            onLoadRun={(id) => void loadRun(id)}
          />
        )}
      </section>

      {selectedNode && (
        <DetailPanel
          node={selectedNode}
          neighbors={
            Array.isArray(neighborsForSelected)
              ? neighborsForSelected
              : undefined
          }
          loadingNeighbors={neighborsForSelected === 'loading'}
          onSelect={(n) => setSelectedNode(n)}
          onExpand={(id) => void loadNeighbors(id)}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </main>
  );
}

function SessionCard({
  summary,
  view,
  active,
  onClick,
}: {
  summary: SessionSummary;
  view: SessionView | 'loading' | 'missing' | undefined;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  const ready = view && view !== 'loading' && view !== 'missing';
  const firstUserMsg = ready
    ? String(view.turns[0]?.turn.props['userMessage'] ?? '').trim()
    : '';
  const entityCount = ready
    ? new Set(view.turns.flatMap((t) => t.entities.map((e) => e.id))).size
    : 0;
  const agents = ready
    ? new Set(
        view.turns.flatMap((t) => {
          const list = (t.turn.props['agents'] ??
            t.turn.props['invokedAgents']) as unknown;
          return Array.isArray(list) ? list.map(String) : [];
        }),
      )
    : new Set<string>();

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full flex-col gap-1 border-l-2 px-3 py-2 text-left transition',
        active
          ? 'border-purple-500 bg-neutral-100 dark:bg-neutral-800'
          : 'border-transparent hover:border-neutral-300 hover:bg-neutral-50 dark:hover:border-neutral-600 dark:hover:bg-neutral-800/50',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 text-[10px] text-neutral-500">
        <span className="font-mono">{relativeTime(summary.lastAt)}</span>
        <span className="ml-auto flex items-center gap-1">
          <Badge color="slate">💬 {summary.turnCount}</Badge>
          {entityCount > 0 && (
            <Badge color="emerald">🏷 {entityCount}</Badge>
          )}
        </span>
      </div>
      {firstUserMsg ? (
        <div className="line-clamp-2 text-xs text-neutral-700 dark:text-neutral-300">
          {firstUserMsg}
        </div>
      ) : (
        <div className="truncate font-mono text-[10px] text-neutral-400">
          {summary.scope}
        </div>
      )}
      <div className="flex items-center gap-1 text-[10px]">
        {agents.size > 0 &&
          [...agents].slice(0, 3).map((a) => (
            <span
              key={a}
              className="rounded-full bg-cyan-50 px-1.5 py-0.5 font-mono text-cyan-900 ring-1 ring-cyan-200 dark:bg-cyan-900/30 dark:text-cyan-100 dark:ring-cyan-800"
            >
              🤖 {a}
            </span>
          ))}
        {view === 'loading' && (
          <span className="text-[10px] text-neutral-400">lädt…</span>
        )}
      </div>
    </button>
  );
}

function Badge({
  color,
  children,
}: {
  color: 'slate' | 'emerald';
  children: React.ReactNode;
}): React.ReactElement {
  const cls =
    color === 'emerald'
      ? 'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-100 dark:ring-emerald-800'
      : 'bg-neutral-100 text-neutral-700 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700';
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ring-1 ${cls}`}
    >
      {children}
    </span>
  );
}

function ModeBtn({
  active,
  onClick,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'px-3 py-1 font-semibold disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
          : 'bg-white text-neutral-600 hover:bg-neutral-100 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function FilterChip({
  label,
  hint,
  active,
  onClick,
  tone,
}: {
  label: string;
  hint: string;
  active: boolean;
  onClick: () => void;
  tone: 'emerald' | 'purple' | 'slate' | 'amber';
}): React.ReactElement {
  const activeTone: Record<typeof tone, string> = {
    emerald:
      'border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-100',
    purple:
      'border-purple-400 bg-purple-50 text-purple-900 dark:border-purple-700 dark:bg-purple-900/30 dark:text-purple-100',
    slate:
      'border-slate-400 bg-slate-100 text-slate-900 dark:border-slate-600 dark:bg-slate-800/60 dark:text-slate-100',
    amber:
      'border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={[
        'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition',
        active
          ? activeTone[tone]
          : 'border-neutral-200 bg-white text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-neutral-500',
      ].join(' ')}
    >
      {active ? '●' : '○'} {label}
    </button>
  );
}

function findNodeInState(
  id: string,
  sessionViews: Record<string, SessionView | 'loading' | 'missing'>,
  runCache: Record<string, RunTraceView | 'loading' | 'missing'>,
  neighborsByNode: Record<string, GraphNode[] | 'loading'>,
): GraphNode | null {
  for (const v of Object.values(sessionViews)) {
    if (!v || v === 'loading' || v === 'missing') continue;
    if (v.session.id === id) return v.session;
    for (const t of v.turns) {
      if (t.turn.id === id) return t.turn;
      for (const e of t.entities) if (e.id === id) return e;
    }
  }
  for (const v of Object.values(runCache)) {
    if (!v || v === 'loading' || v === 'missing') continue;
    if (v.run.id === id) return v.run;
    if (v.user?.id === id) return v.user;
    for (const tc of v.orchestratorToolCalls) {
      if (tc.node.id === id) return tc.node;
      for (const e of tc.producedEntities) if (e.id === id) return e;
    }
    for (const inv of v.agentInvocations) {
      if (inv.node.id === id) return inv.node;
      for (const tc of inv.toolCalls) {
        if (tc.node.id === id) return tc.node;
        for (const e of tc.producedEntities) if (e.id === id) return e;
      }
    }
  }
  for (const arr of Object.values(neighborsByNode)) {
    if (Array.isArray(arr)) for (const n of arr) if (n.id === id) return n;
  }
  return null;
}
