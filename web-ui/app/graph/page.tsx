'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ListView from './_components/ListView';
import DetailPanel from './_components/DetailPanel';
import {
  DEFAULT_FILTER,
  type GraphFilter,
  type GraphNode,
  type IssueOverlay,
  type MemoryView,
  type PlanOverlay,
  type RunTraceView,
  type SessionSummary,
  type SessionView,
  type Stats,
  type TopicOverlay,
  createLimiter,
  relativeTime,
} from './_components/graphTypes';

// Shared across the page lifetime: at most 4 concurrent /session fetches.
const sessionFetchLimit = createLimiter(4);

const GraphCanvas = dynamic(() => import('./_components/GraphCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-[color:var(--fg-muted)]">
      lade Graph-Canvas…
    </div>
  ),
});

type ViewMode = 'graph' | 'list' | 'memory';

const ALL = '__ALL__';
/** Pseudo scope value: sidebar entry "🧠 Alle Memories" → loads
 *  `/memories?scope=__ALL__` and locks the view-mode to 'memory'. */
const MEMORIES = '__MEMORIES__';

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
  const [memoryViews, setMemoryViews] = useState<
    Record<string, MemoryView | 'loading' | 'missing'>
  >({});
  // Slice 11.5 — Topic + Issue overlays. Single cached payload per
  // overlay (tenant-wide, not scope-dependent). Refetched on toggle.
  const [topicOverlay, setTopicOverlay] = useState<
    TopicOverlay | 'loading' | 'missing' | null
  >(null);
  const [issueOverlay, setIssueOverlay] = useState<
    IssueOverlay | 'loading' | 'missing' | null
  >(null);
  // #133 — per-turn plan DAGs, scope-keyed (a session has one plan per
  // plan-worthy turn). Loaded lazily when the Pläne filter is toggled.
  const [planViews, setPlanViews] = useState<
    Record<string, PlanOverlay | 'loading' | 'missing'>
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
    // Initial read of a browser API unavailable during SSR; the `change`
    // listener below handles every subsequent update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // Fetch-on-mount: refresh()'s only synchronous setState is setError(null),
    // a same-value no-op on mount; the data lands after the awaited fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  // Load the active session's own view on demand. The pseudo scopes
  // (`__ALL__`, `__MEMORIES__`) are not real sessions and would 404 on
  // `/dev/graph/session/:scope`.
  useEffect(() => {
    if (selected === ALL || selected === MEMORIES) return;
    // Load-on-selection: loadSessionView marks the scope 'loading' (one
    // intended render) before fetching — not a cascading-render anti-pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!sessionViews[selected]) void loadSessionView(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // In 'Alle' mode only: load all session views (throttled to 4 concurrent).
  useEffect(() => {
    if (selected !== ALL) return;
    for (const s of sessions) {
      // loadSessionView marks each scope 'loading' (one intended render)
      // before fetching — not a cascading-render anti-pattern.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
      // loadRun marks the turn 'loading' (one intended render) before
      // fetching — not a cascading-render anti-pattern.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!runCache[t.turn.id]) void loadRun(t.turn.id);
    }
  }, [mode, selected, sessionViews, runCache, loadRun]);

  const loadTopicOverlay = useCallback(async (): Promise<void> => {
    setTopicOverlay('loading');
    try {
      const res = await fetch('/bot-api/dev/graph/topics');
      if (!res.ok) {
        setTopicOverlay('missing');
        return;
      }
      const body = (await res.json()) as TopicOverlay;
      setTopicOverlay(body);
    } catch {
      setTopicOverlay('missing');
    }
  }, []);

  const loadIssueOverlay = useCallback(async (): Promise<void> => {
    setIssueOverlay('loading');
    try {
      const res = await fetch('/bot-api/dev/graph/issues');
      if (!res.ok) {
        setIssueOverlay('missing');
        return;
      }
      const body = (await res.json()) as IssueOverlay;
      setIssueOverlay(body);
    } catch {
      setIssueOverlay('missing');
    }
  }, []);

  // Slice 11.5 — lazy-load on first filter activation. The overlays
  // are tenant-wide, so one cached fetch per page lifetime is enough.
  useEffect(() => {
    if (graphFilter.showTopics && topicOverlay === null) {
      // loadTopicOverlay marks the overlay 'loading' before fetching —
      // one intended render, not a cascading-render anti-pattern.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadTopicOverlay();
    }
  }, [graphFilter.showTopics, topicOverlay, loadTopicOverlay]);
  useEffect(() => {
    if (graphFilter.showIssues && issueOverlay === null) {
      // loadIssueOverlay marks the overlay 'loading' before fetching —
      // one intended render, not a cascading-render anti-pattern.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadIssueOverlay();
    }
  }, [graphFilter.showIssues, issueOverlay, loadIssueOverlay]);

  const activeTopicOverlay: TopicOverlay | null =
    typeof topicOverlay === 'object' && topicOverlay !== null
      ? topicOverlay
      : null;
  const activeIssueOverlay: IssueOverlay | null =
    typeof issueOverlay === 'object' && issueOverlay !== null
      ? issueOverlay
      : null;
  const planForSelected = planViews[selected];
  const activePlanOverlay: PlanOverlay | null =
    typeof planForSelected === 'object' && planForSelected !== null
      ? planForSelected
      : null;

  const loadMemoryView = useCallback(
    async (scope: string): Promise<void> => {
      const cached = memoryViews[scope];
      if (cached && cached !== 'loading' && cached !== 'missing') return;
      if (cached === 'loading') return;
      setMemoryViews((p) => ({ ...p, [scope]: 'loading' }));
      try {
        const res = await fetch(
          `/bot-api/dev/graph/memories?scope=${encodeURIComponent(scope)}`,
        );
        if (!res.ok) {
          setMemoryViews((p) => ({ ...p, [scope]: 'missing' }));
          return;
        }
        const body = (await res.json()) as MemoryView;
        setMemoryViews((p) => ({ ...p, [scope]: body }));
      } catch {
        setMemoryViews((p) => ({ ...p, [scope]: 'missing' }));
      }
    },
    [memoryViews],
  );

  const loadPlanView = useCallback(
    async (scope: string): Promise<void> => {
      const cached = planViews[scope];
      if (cached === 'loading') return;
      if (cached && cached !== 'missing') return;
      setPlanViews((p) => ({ ...p, [scope]: 'loading' }));
      try {
        const res = await fetch(
          `/bot-api/dev/graph/plans?scope=${encodeURIComponent(scope)}`,
        );
        if (!res.ok) {
          setPlanViews((p) => ({ ...p, [scope]: 'missing' }));
          return;
        }
        const body = (await res.json()) as PlanOverlay;
        setPlanViews((p) => ({ ...p, [scope]: body }));
      } catch {
        setPlanViews((p) => ({ ...p, [scope]: 'missing' }));
      }
    },
    [planViews],
  );

  // #133 — load the selected session's plan DAGs when Pläne is on. Plans are
  // per-scope; the ALL / MEMORIES pseudo-scopes have none.
  useEffect(() => {
    if (
      graphFilter.showPlans &&
      selected !== ALL &&
      selected !== MEMORIES &&
      planViews[selected] === undefined
    ) {
      // loadPlanView marks the scope 'loading' before fetching — one
      // intended render, not a cascading-render anti-pattern.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadPlanView(selected);
    }
  }, [graphFilter.showPlans, selected, planViews, loadPlanView]);

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
    const node = findNodeInState(
      nodeId,
      sessionViews,
      runCache,
      neighborsByNode,
      memoryViews,
    );
    if (node?.type === 'Turn') void loadRun(nodeId);
    void loadNeighbors(nodeId);
  };

  const handleEntityClickFromList = (id: string): void => {
    void loadNeighbors(id);
    setMode('graph');
    const node = findNodeInState(
      id,
      sessionViews,
      runCache,
      neighborsByNode,
      memoryViews,
    );
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
    if (selected === ALL || selected === MEMORIES) return null;
    const v = sessionViews[selected];
    if (!v || v === 'loading' || v === 'missing') return null;
    return v;
  }, [selected, sessionViews]);

  const memoryScopeKey =
    selected === MEMORIES ? ALL : selected === ALL ? null : selected;
  const memoriesNeeded =
    memoryScopeKey !== null &&
    (selected === MEMORIES || mode === 'memory' || graphFilter.showMemories);
  useEffect(() => {
    if (!memoriesNeeded || memoryScopeKey === null) return;
    // loadMemoryView marks the scope 'loading' (one intended render)
    // before fetching — not a cascading-render anti-pattern; mirrors
    // the loadSessionView effect above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!memoryViews[memoryScopeKey]) void loadMemoryView(memoryScopeKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoriesNeeded, memoryScopeKey]);

  const activeMemoryView: MemoryView | null = useMemo(() => {
    if (memoryScopeKey === null) return null;
    const v = memoryViews[memoryScopeKey];
    if (!v || v === 'loading' || v === 'missing') return null;
    return v;
  }, [memoryScopeKey, memoryViews]);

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

  const memoryCount = activeMemoryView?.memories.length ?? 0;
  const headerTitle =
    selected === MEMORIES
      ? `🧠 Alle Memories (${memoryCount})`
      : selected === ALL
        ? `🌐 Alle Sessions (${allLoadedCount}/${allTotal})`
        : (activeView?.session.id ?? selected);

  const turnSum =
    selected === MEMORIES
      ? memoryCount
      : selected === ALL
        ? allViews.reduce((acc, v) => acc + v.turns.length, 0)
        : (activeView?.turns.length ?? 0);

  return (
    <main className="flex h-full">
      <aside className="flex w-80 min-w-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-elevated)]">
        <div className="border-b border-[color:var(--border)] px-3 py-3 text-xs">
          <div className="mb-1 font-semibold">Graph</div>
          {stats && (
            <div className="space-y-0.5 font-mono text-[11px] text-[color:var(--fg-muted)]">
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
            className="mt-2 text-[11px] text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
          >
            ↻ neu laden
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            setSelected(ALL);
            setSelectedNode(null);
            if (mode === 'memory') setMode('graph');
          }}
          className={[
            'mx-2 mb-1 mt-2 flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition',
            selected === ALL
              ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--accent)]'
              : 'border-[color:var(--border)] hover:border-[color:var(--border-strong)]',
          ].join(' ')}
        >
          <span className="text-base">🌐</span>
          <span className="flex flex-col">
            <span className="font-semibold">Alle Sessions</span>
            <span className="text-[10px] text-[color:var(--fg-muted)]">
              Gesamte Wolke · {allTotal} Sessions
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => {
            setSelected(MEMORIES);
            setSelectedNode(null);
            setMode('memory');
          }}
          className={[
            'mx-2 mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition',
            selected === MEMORIES
              ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--accent)]'
              : 'border-[color:var(--border)] hover:border-[color:var(--border-strong)]',
          ].join(' ')}
        >
          <span className="text-base">🧠</span>
          <span className="flex flex-col">
            <span className="font-semibold">Alle Memories</span>
            <span className="text-[10px] text-[color:var(--fg-muted)]">
              Palaia-Provenance · 2-Hops
            </span>
          </span>
        </button>

        <div className="mx-2 mb-2">
          <input
            type="text"
            placeholder="Sessions filtern…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-2 py-1 text-xs outline-none placeholder:text-[color:var(--fg-subtle)] focus:border-[color:var(--border-strong)]"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--fg-subtle)]">
            <span>
              Sessions ({filteredSessions.length}
              {filter ? `/${sessions.length}` : ''})
            </span>
          </div>
          {error && (
            <div className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
              {error}
            </div>
          )}
          {sessions.length === 0 && !error && (
            <div className="px-3 py-2 text-xs text-[color:var(--fg-muted)]">
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

      <section className="flex min-w-0 flex-1 flex-col bg-[color:var(--bg-soft)]">
        <div className="flex items-center gap-3 border-b border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-2 text-xs">
          <span className="truncate font-mono text-[color:var(--fg-muted)]">
            {headerTitle}
          </span>
          <span className="text-[11px] text-[color:var(--fg-muted)]">
            {selected === MEMORIES
              ? `${turnSum} Memor${turnSum === 1 ? 'y' : 'ies'}`
              : `${turnSum} Turn${turnSum === 1 ? '' : 's'}`}
            {loadingAll ? ' · lade…' : ''}
          </span>
          {mode !== 'list' && (
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {mode === 'graph' && (
                <>
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
                  <FilterChip
                    label="Memories"
                    hint="MK + Excerpt + Provenance (2 Hops)"
                    active={graphFilter.showMemories}
                    onClick={() => toggleFilter('showMemories')}
                    tone="fuchsia"
                  />
                </>
              )}
              {/* Topics + Issues sind in jedem Canvas-Mode nützlich —
                  sowohl im graph-Modus als Overlay, als auch im
                  memory-Modus als Cluster-Brücke zwischen MKs. */}
              <FilterChip
                label="Topics"
                hint="Cluster-Knoten + HAS_TOPIC (Slice 11)"
                active={graphFilter.showTopics}
                onClick={() => toggleFilter('showTopics')}
                tone="teal"
              />
              <FilterChip
                label="Issues"
                hint="Konflikte + Duplikat-Kandidaten"
                active={graphFilter.showIssues}
                onClick={() => toggleFilter('showIssues')}
                tone="red"
              />
              <FilterChip
                label="Pläne"
                hint="Plan-DAG der gewählten Session (#133)"
                active={graphFilter.showPlans}
                onClick={() => toggleFilter('showPlans')}
                tone="fuchsia"
              />
            </div>
          )}
          <div
            className={[
              'inline-flex overflow-hidden rounded border border-[color:var(--border)]',
              mode === 'graph' ? '' : 'ml-auto',
            ].join(' ')}
          >
            <ModeBtn
              active={mode === 'graph'}
              onClick={() => setMode('graph')}
              label="Graph"
              disabled={selected === MEMORIES}
            />
            <ModeBtn
              active={mode === 'list'}
              onClick={() => setMode('list')}
              label="Liste"
              disabled={selected === ALL || selected === MEMORIES}
            />
            <ModeBtn
              active={mode === 'memory'}
              onClick={() => setMode('memory')}
              label="Memory"
            />
          </div>
        </div>

        {selected === MEMORIES ? (
          <div className="min-h-0 flex-1">
            {activeMemoryView ? (
              <GraphCanvas
                session={null}
                extraSessions={[]}
                runs={{}}
                expansions={expansionList}
                memoryView={activeMemoryView}
                focusMemories
                topicOverlay={graphFilter.showTopics ? activeTopicOverlay : null}
                issueOverlay={graphFilter.showIssues ? activeIssueOverlay : null}
                selectedId={selectedNode?.id ?? null}
                filter={{ ...graphFilter, showMemories: true }}
                onSelectNode={setSelectedNode}
                onExpandNode={handleGraphNodeExpand}
                dark={dark}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[color:var(--fg-muted)]">
                lade Memories…
              </div>
            )}
          </div>
        ) : selected === ALL ? (
          <div className="min-h-0 flex-1">
            <GraphCanvas
              session={null}
              extraSessions={allViews}
              runs={{}}
              expansions={expansionList}
              memoryView={
                graphFilter.showMemories ? activeMemoryView : null
              }
              topicOverlay={graphFilter.showTopics ? activeTopicOverlay : null}
              issueOverlay={graphFilter.showIssues ? activeIssueOverlay : null}
              selectedId={selectedNode?.id ?? null}
              filter={graphFilter}
              onSelectNode={setSelectedNode}
              onExpandNode={handleGraphNodeExpand}
              dark={dark}
            />
          </div>
        ) : !activeView ? (
          <div className="flex h-full items-center justify-center text-sm text-[color:var(--fg-muted)]">
            lade Session…
          </div>
        ) : mode === 'memory' ? (
          <div className="min-h-0 flex-1">
            {activeMemoryView ? (
              <GraphCanvas
                session={activeView}
                runs={runsLoaded}
                expansions={expansionList}
                memoryView={activeMemoryView}
                focusMemories
                topicOverlay={graphFilter.showTopics ? activeTopicOverlay : null}
                issueOverlay={graphFilter.showIssues ? activeIssueOverlay : null}
                selectedId={selectedNode?.id ?? null}
                filter={{ ...graphFilter, showMemories: true }}
                onSelectNode={setSelectedNode}
                onExpandNode={handleGraphNodeExpand}
                dark={dark}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[color:var(--fg-muted)]">
                lade Memories…
              </div>
            )}
          </div>
        ) : mode === 'graph' ? (
          <div className="min-h-0 flex-1">
            <GraphCanvas
              session={activeView}
              runs={runsLoaded}
              expansions={expansionList}
              memoryView={
                graphFilter.showMemories ? activeMemoryView : null
              }
              topicOverlay={graphFilter.showTopics ? activeTopicOverlay : null}
              issueOverlay={graphFilter.showIssues ? activeIssueOverlay : null}
              planOverlay={graphFilter.showPlans ? activePlanOverlay : null}
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
          provenance={
            activeMemoryView
              ? (activeMemoryView.memories.find(
                  (m) => m.node.id === selectedNode.id,
                ) ?? null)
              : null
          }
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
          ? 'border-[color:var(--accent)] bg-[color:var(--bg-soft)]'
          : 'border-transparent hover:border-[color:var(--border)] hover:bg-[color:var(--bg-soft)]',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 text-[10px] text-[color:var(--fg-muted)]">
        <span className="font-mono">{relativeTime(summary.lastAt)}</span>
        <span className="ml-auto flex items-center gap-1">
          <Badge color="slate">💬 {summary.turnCount}</Badge>
          {entityCount > 0 && (
            <Badge color="emerald">🏷 {entityCount}</Badge>
          )}
        </span>
      </div>
      {firstUserMsg ? (
        <div className="line-clamp-2 text-xs text-[color:var(--fg)]">
          {firstUserMsg}
        </div>
      ) : (
        <div className="truncate font-mono text-[10px] text-[color:var(--fg-subtle)]">
          {summary.scope}
        </div>
      )}
      <div className="flex items-center gap-1 text-[10px]">
        {agents.size > 0 &&
          [...agents].slice(0, 3).map((a) => (
            <span
              key={a}
              className="rounded-full bg-[color:var(--accent)]/10 px-1.5 py-0.5 font-mono text-[color:var(--accent)] ring-1 ring-[color:var(--accent)]"
            >
              🤖 {a}
            </span>
          ))}
        {view === 'loading' && (
          <span className="text-[10px] text-[color:var(--fg-subtle)]">lädt…</span>
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
      ? 'bg-[color:var(--success)]/10 text-[color:var(--success)] ring-[color:var(--success)]'
      : 'bg-[color:var(--bg-soft)] text-[color:var(--fg)] ring-[color:var(--border-strong)]';
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
          ? 'bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
          : 'bg-[color:var(--bg-elevated)] text-[color:var(--fg-muted)] hover:bg-[color:var(--bg-soft)]',
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
  tone: 'emerald' | 'purple' | 'slate' | 'amber' | 'fuchsia' | 'teal' | 'red';
}): React.ReactElement {
  const activeTone: Record<typeof tone, string> = {
    emerald:
      'border-[color:var(--success)] bg-[color:var(--success)]/10 text-[color:var(--success)]',
    purple:
      'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
    slate:
      'border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] text-[color:var(--fg-strong)]',
    amber:
      'border-[color:var(--warning)] bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
    fuchsia:
      'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
    teal:
      'border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
    red:
      'border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 text-[color:var(--danger)]',
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
          : 'border-[color:var(--border)] bg-[color:var(--bg-elevated)] text-[color:var(--fg-muted)] hover:border-[color:var(--border-strong)]',
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
  memoryViews: Record<string, MemoryView | 'loading' | 'missing'> = {},
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
  for (const v of Object.values(memoryViews)) {
    if (!v || v === 'loading' || v === 'missing') continue;
    for (const m of v.memories) {
      if (m.node.id === id) return m.node;
      for (const n of m.level1) if (n.id === id) return n;
      for (const n of m.level2) if (n.id === id) return n;
    }
  }
  return null;
}
