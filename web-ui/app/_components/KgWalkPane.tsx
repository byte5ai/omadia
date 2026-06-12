'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Maximize2, Minimize2, Network, X } from 'lucide-react';

import type { KgWalkPayload } from '../_lib/chatSessions';
import { useFloatingWindow } from './useFloatingWindow';

// react-force-graph-2d touches `window`/canvas at import time, so it must be
// client-only. Ported from dk-intelligent-core's GraphPanel.
const ForceGraph = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface Props {
  /** The KG-walk this assistant turn surfaced; null hides the launcher. */
  walk: KgWalkPayload | null;
}

/** Accent for roots + traversed edges. Matches the chat's indigo phase pill. */
const ROOT_ACCENT = '#6366f1';

/** Emerald accent for freshly-inserted nodes/edges (matches Turn green family). */
const INSERT_ACCENT = '#34d399';

/**
 * Clean, small per-kind palette. Anything outside the map falls back to the
 * neutral slate so an unexpected kind never produces a jarring color.
 */
const KIND_COLORS: Record<string, string> = {
  MemorableKnowledge: '#818cf8',
  Turn: '#34d399',
  Entity: '#94a3b8',
  User: '#f472b6',
  Process: '#f59e0b',
  Insight: '#22d3ee',
};
const KIND_FALLBACK = '#94a3b8';

function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? KIND_FALLBACK;
}

/** Delay between hop reveals, ms. Snappy so the user isn't trapped waiting. */
const HOP_INTERVAL_MS = 320;

interface GraphNodeDatum {
  id: string;
  name: string;
  kind: string;
  color: string;
  isRoot: boolean;
  hop: number;
  score?: number;
  /** Written by THIS turn — rendered with an emerald pulse + always-on label. */
  inserted: boolean;
}

interface GraphLinkDatum {
  source: string;
  target: string;
  type: string;
  hop: number;
  inserted: boolean;
}

function truncateLabel(label: string, max = 24): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

/**
 * Floating "flying pane" visualization of the knowledge-graph neighborhood a
 * turn walked (anchored bottom-right). A launcher chip opens a draggable /
 * resizable / maximizable window with a de-noised force graph on top and a
 * hop-by-hop details list below. Window mechanics live in
 * {@link useFloatingWindow}; this component owns the graph + list + insert
 * visuals.
 */
export function KgWalkPane({ walk }: Props): React.ReactElement | null {
  const t = useTranslations('chat.kgWalk');
  const win = useFloatingWindow({ anchor: 'right' });
  /** id of the node currently hovered (in graph or list) for cross-highlight. */
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [revealedHop, setRevealedHop] = useState(0);
  const [animatedWalk, setAnimatedWalk] = useState<KgWalkPayload | null>(walk);

  const maxHop = useMemo(() => {
    if (!walk) return 0;
    return walk.edges.reduce((acc, e) => Math.max(acc, e.hop), 0);
  }, [walk]);

  // Reset the hop cursor + clear highlight when a new turn's walk arrives,
  // via React's "adjust state during render" pattern (no setState in effect).
  if (animatedWalk !== walk) {
    setAnimatedWalk(walk);
    setRevealedHop(0);
    setActiveNodeId(null);
  }

  // Auto-open whenever a new walk arrives (the feature ships on). Keyed on
  // `walk` identity: closing the pane keeps it shut for the current walk, but
  // the next turn's walk — including a merged `kg_insert` delta, which produces
  // a fresh object — pops it back open. Deferred a tick so the first client
  // paint still matches the SSR launcher (no geometry mismatch) and so we never
  // call setState synchronously inside the effect body.
  const { openWindow } = win;
  useEffect(() => {
    if (!walk) return;
    const id = setTimeout(() => {
      openWindow();
    }, 0);
    return () => {
      clearTimeout(id);
    };
  }, [walk, openWindow]);

  // Hop-reveal timer — settles quickly so the user isn't blocked.
  useEffect(() => {
    if (!win.open || !walk || maxHop === 0) return;
    const id = setInterval(() => {
      setRevealedHop((hop) => {
        if (hop >= maxHop) {
          clearInterval(id);
          return hop;
        }
        return hop + 1;
      });
    }, HOP_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, [win.open, walk, maxHop]);

  // Map each node to the smallest hop at which it becomes reachable.
  const nodeHopById = useMemo(() => {
    const map = new Map<string, number>();
    if (!walk) return map;
    for (const id of walk.rootIds) map.set(id, 0);
    for (const e of walk.edges) {
      for (const id of [e.from, e.to]) {
        const prev = map.get(id);
        if (prev === undefined || e.hop < prev) map.set(id, e.hop);
      }
    }
    for (const n of walk.nodes) {
      if (!map.has(n.id)) map.set(n.id, 0);
    }
    return map;
  }, [walk]);

  const rootSet = useMemo(() => new Set<string>(walk?.rootIds ?? []), [walk]);

  const labelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of walk?.nodes ?? []) map.set(n.id, n.label);
    return map;
  }, [walk]);

  // Full graph data (all hops). The reveal animation dims/hides un-revealed
  // hops via opacity rather than rebuilding the sim, so layout stays stable.
  const data = useMemo((): {
    nodes: GraphNodeDatum[];
    links: GraphLinkDatum[];
  } => {
    if (!walk) return { nodes: [], links: [] };
    const nodes: GraphNodeDatum[] = walk.nodes.map((n) => ({
      id: n.id,
      name: n.label,
      kind: n.kind,
      color: kindColor(n.kind),
      isRoot: rootSet.has(n.id),
      hop: nodeHopById.get(n.id) ?? 0,
      inserted: n.inserted === true,
      ...(n.score !== undefined ? { score: n.score } : {}),
    }));
    const links: GraphLinkDatum[] = walk.edges.map((e) => ({
      source: e.from,
      target: e.to,
      type: e.type,
      hop: e.hop,
      inserted: e.inserted === true,
    }));
    return { nodes, links };
  }, [walk, nodeHopById, rootSet]);

  // Compaction force tuning. The goal is a tight, centered cloud rather than a
  // few hub-and-spoke clusters drifting into empty corners: modest repulsion +
  // short links keep neighbours close, a small collide radius stops disc/label
  // overlap, and weak x/y centering forces gravitate disconnected components
  // toward the middle so `zoomToFit` frames a dense graph instead of mostly
  // background.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || data.nodes.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const { forceCollide, forceX, forceY } = await import('d3-force-3d');
        if (cancelled || !fgRef.current) return;
        fgRef.current.d3Force('charge')?.strength(-90).distanceMax(220);
        fgRef.current.d3Force('link')?.distance(32);
        fgRef.current.d3Force('collide', forceCollide(11));
        fgRef.current.d3Force('x', forceX(0).strength(0.06));
        fgRef.current.d3Force('y', forceY(0).strength(0.06));
        fgRef.current.d3ReheatSimulation?.();
      } catch {
        /* ignore — force tuning is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.nodes.length]);

  // Re-fit the camera as the layout settles.
  const canvasW = win.canvas.w;
  const canvasH = win.canvas.h;
  useEffect(() => {
    if (!fgRef.current || canvasW === 0 || canvasH === 0) return;
    const id = setTimeout(() => {
      try {
        fgRef.current?.zoomToFit?.(400, 40);
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      clearTimeout(id);
    };
  }, [canvasW, canvasH, data.nodes.length]);

  // Hop-grouped node list for the details panel.
  const hopGroups = useMemo(() => {
    if (!walk) return [] as Array<{ hop: number; nodes: GraphNodeDatum[] }>;
    const byHop = new Map<number, GraphNodeDatum[]>();
    for (const n of data.nodes) {
      const arr = byHop.get(n.hop) ?? [];
      arr.push(n);
      byHop.set(n.hop, arr);
    }
    return Array.from(byHop.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([hop, nodes]) => ({ hop, nodes }));
  }, [walk, data.nodes]);

  // Incoming edge per node (for "← [type] from X" hints in the list).
  const incomingEdgeByNode = useMemo(() => {
    const map = new Map<string, { fromLabel: string; type: string }>();
    for (const e of walk?.edges ?? []) {
      if (!map.has(e.to)) {
        map.set(e.to, {
          fromLabel: labelById.get(e.from) ?? e.from,
          type: e.type,
        });
      }
    }
    return map;
  }, [walk, labelById]);

  if (!walk) return null;

  const totalNodes = walk.nodes.length;
  const insertedCount = walk.nodes.filter((n) => n.inserted === true).length;

  // Launcher chip when the pane is closed.
  if (!win.open) {
    return (
      <button
        type="button"
        onClick={win.openWindow}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full border border-[color:var(--accent)] bg-[color:var(--bg-elevated)]/90 px-4 py-2 text-sm font-medium text-[color:var(--accent)] shadow-lg backdrop-blur transition hover:bg-[color:var(--bg-elevated)]"
        aria-label={t('openLabel')}
        title={t('openLabel')}
      >
        <Network size={16} aria-hidden />
        {t('openLabel')}
        <span className="rounded bg-[color:var(--accent)]/10 px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--accent)]">
          {totalNodes}
        </span>
      </button>
    );
  }

  // While geometry is being seeded on first open.
  if (!win.style) return null;

  return (
    <section
      className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)] shadow-2xl"
      style={win.style}
      aria-label={t('title')}
    >
      <header
        onPointerDown={win.headerHandlers.onPointerDown}
        onPointerMove={win.headerHandlers.onPointerMove}
        onPointerUp={win.headerHandlers.onPointerUp}
        className={[
          'flex items-center justify-between gap-2 border-b border-white/10 bg-[color:var(--bg-inverse)] px-3 py-2 select-none',
          win.maximized ? '' : 'cursor-move',
        ].join(' ')}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-[color:var(--fg-on-dark)]">
            <Network size={13} aria-hidden className="text-[color:var(--accent)]" />
            {t('title')}
          </span>
          <span className="truncate text-[10px] text-[color:var(--fg-muted)]">
            {t('subtitle')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="flex gap-1 font-mono text-[10px] text-[color:var(--fg-subtle)]">
            <span className="rounded bg-white/10 px-1.5 py-0.5">
              {t('badgeNodes', { count: totalNodes })}
            </span>
            <span className="rounded bg-white/10 px-1.5 py-0.5">
              {t('badgeHops', { count: maxHop })}
            </span>
            {insertedCount > 0 && (
              <span className="rounded bg-[color:var(--success)]/20 px-1.5 py-0.5 text-[color:var(--success)]">
                {t('badgeInserted', { count: insertedCount })}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={win.toggleMaximized}
            className="rounded p-1 text-[color:var(--fg-subtle)] transition hover:bg-white/10 hover:text-[color:var(--fg-on-dark)]"
            aria-label={win.maximized ? t('restore') : t('maximize')}
            title={win.maximized ? t('restore') : t('maximize')}
          >
            {win.maximized ? (
              <Minimize2 size={14} aria-hidden />
            ) : (
              <Maximize2 size={14} aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={win.close}
            className="rounded p-1 text-[color:var(--fg-subtle)] transition hover:bg-white/10 hover:text-[color:var(--fg-on-dark)]"
            aria-label={t('close')}
            title={t('close')}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      </header>

      {/* Graph region — fills the top, leaving the list a flexible share. */}
      <div ref={win.setCanvasRef} className="relative min-h-0 flex-[3]">
        {canvasW > 0 && canvasH > 0 && (
          <ForceGraph
            ref={fgRef}
            graphData={data}
            width={canvasW}
            height={canvasH}
            backgroundColor="#0b1220"
            nodeRelSize={5}
            cooldownTicks={120}
            d3VelocityDecay={0.3}
            onEngineStop={() => {
              try {
                fgRef.current?.zoomToFit?.(400, 40);
              } catch {
                /* ignore */
              }
            }}
            onNodeHover={(node) => {
              setActiveNodeId(node ? (node as GraphNodeDatum).id : null);
            }}
            linkColor={(l) => {
              const e = l as GraphLinkDatum;
              if (e.inserted) return 'rgba(52, 211, 153, 0.7)';
              return e.hop <= revealedHop
                ? 'rgba(99, 102, 241, 0.45)'
                : 'rgba(99, 102, 241, 0.08)';
            }}
            linkWidth={(l) => ((l as GraphLinkDatum).inserted ? 2.2 : 1.4)}
            linkLabel={(l) => (l as GraphLinkDatum).type}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            linkDirectionalParticles={(l) => {
              const e = l as GraphLinkDatum;
              if (e.inserted) return 3; // a steady flow = "writing into the graph"
              return e.hop <= revealedHop ? 1 : 0;
            }}
            linkDirectionalParticleWidth={(l) =>
              (l as GraphLinkDatum).inserted ? 2.6 : 1.8
            }
            linkDirectionalParticleColor={(l) =>
              (l as GraphLinkDatum).inserted ? INSERT_ACCENT : ROOT_ACCENT
            }
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as GraphNodeDatum & { x?: number; y?: number };
              const x = n.x ?? 0;
              const y = n.y ?? 0;
              // Inserted nodes are always treated as revealed — a write should
              // never be dimmed behind the hop reveal.
              const revealed = n.inserted || n.hop <= revealedHop;
              const isActive = n.id === activeNodeId;
              const r = n.inserted ? 6 : n.isRoot ? 6.5 : 4;
              ctx.globalAlpha = revealed ? 1 : 0.18;

              // Inserted: bold emerald double-ring so a fresh write pops.
              if (n.inserted) {
                ctx.beginPath();
                ctx.arc(x, y, r + 4.5, 0, 2 * Math.PI);
                ctx.strokeStyle = INSERT_ACCENT;
                ctx.lineWidth = 2.4;
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(x, y, r + 7.5, 0, 2 * Math.PI);
                ctx.strokeStyle = 'rgba(52, 211, 153, 0.35)';
                ctx.lineWidth = 1.4;
                ctx.stroke();
              } else if (n.isRoot || isActive) {
                // Roots keep the accent ring; active node gets a halo.
                ctx.beginPath();
                ctx.arc(x, y, r + 3.5, 0, 2 * Math.PI);
                ctx.strokeStyle = isActive ? '#fbbf24' : ROOT_ACCENT;
                ctx.lineWidth = isActive ? 2.5 : 2;
                ctx.stroke();
              }

              ctx.fillStyle = n.inserted ? INSERT_ACCENT : n.color;
              ctx.beginPath();
              ctx.arc(x, y, r, 0, 2 * Math.PI);
              ctx.fill();

              // DE-NOISE: only roots, inserts, and the hovered node carry a
              // readable label by default; everyone else stays unlabeled (or
              // appears when zoomed in past a threshold). This kills the overlap.
              const zoomedIn = globalScale > 2.2;
              const showLabel =
                revealed && (n.isRoot || n.inserted || isActive || zoomedIn);
              if (showLabel) {
                const fontSize = 11 / globalScale;
                const label = n.inserted
                  ? `${truncateLabel(n.name)} • ${t('insertedTag')}`
                  : truncateLabel(n.name);
                ctx.fillStyle = n.inserted
                  ? '#a7f3d0'
                  : isActive
                    ? '#fde68a'
                    : '#e2e8f0';
                ctx.font = `${n.inserted ? '600 ' : ''}${String(fontSize)}px system-ui, sans-serif`;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, x + r + 4, y);
              }
              ctx.globalAlpha = 1;
            }}
          />
        )}

        {/* Minimal legend, bottom-left of the canvas. */}
        <div className="pointer-events-none absolute bottom-2 left-2 flex gap-3 rounded-md bg-[color:var(--bg-modal-overlay)] px-2 py-1 text-[10px] text-[color:var(--fg-subtle)] backdrop-blur-sm">
          <span className="flex items-center gap-1">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full ring-2 ring-[#6366f1]"
              style={{ backgroundColor: '#818cf8' }}
            />
            {t('legendRoots')}
          </span>
          <span className="flex items-center gap-1">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: '#94a3b8' }}
            />
            {t('legendNeighbors')}
          </span>
          {insertedCount > 0 && (
            <span className="flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full ring-2 ring-[#34d399]"
                style={{ backgroundColor: INSERT_ACCENT }}
              />
              {t('legendInserted')}
            </span>
          )}
        </div>
      </div>

      {/* Hop-details list — scrollable, grouped by hop. */}
      <div className="min-h-0 flex-[2] overflow-y-auto border-t border-white/10 bg-[color:var(--bg-inverse)]/60">
        <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--fg-muted)]">
          {t('hopListHeader', { nodes: totalNodes, hops: maxHop })}
        </div>
        {hopGroups.map((group) => (
          <div key={group.hop} className="border-t border-white/5 px-3 py-1.5">
            <div className="mb-1 text-[11px] font-semibold text-[color:var(--accent)]">
              {group.hop === 0
                ? t('hopHeaderRoots')
                : t('hopHeader', { hop: group.hop })}
            </div>
            <ul className="flex flex-col gap-0.5">
              {group.nodes.map((n) => {
                const incoming = incomingEdgeByNode.get(n.id);
                const isActive = n.id === activeNodeId;
                return (
                  <li
                    key={n.id}
                    onMouseEnter={() => {
                      setActiveNodeId(n.id);
                    }}
                    onMouseLeave={() => {
                      setActiveNodeId(null);
                    }}
                    className={[
                      'flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]',
                      isActive ? 'bg-white/10' : 'hover:bg-white/5',
                    ].join(' ')}
                  >
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: kindColor(n.kind) }}
                    />
                    <span className="shrink-0 rounded bg-white/10 px-1 py-0.5 font-mono text-[9px] text-[color:var(--fg-subtle)]">
                      {n.kind}
                    </span>
                    {n.inserted && (
                      <span className="shrink-0 rounded bg-[color:var(--success)]/25 px-1 py-0.5 font-mono text-[9px] font-semibold text-[color:var(--success)]">
                        {t('insertedTag')}
                      </span>
                    )}
                    <span
                      className={[
                        'truncate',
                        n.inserted ? 'text-[color:var(--success)]' : 'text-[color:var(--fg-on-dark)]',
                      ].join(' ')}
                      title={n.name}
                    >
                      {truncateLabel(n.name, 40)}
                    </span>
                    {n.isRoot && n.score !== undefined && (
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-[color:var(--success)]">
                        {n.score.toFixed(2)}
                      </span>
                    )}
                    {!n.isRoot && incoming && (
                      <span
                        className="ml-auto shrink-0 truncate font-mono text-[9px] text-[color:var(--fg-muted)]"
                        title={`${incoming.fromLabel} → ${incoming.type}`}
                      >
                        ← {incoming.type}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {/* Resize handle (bottom-right corner). Hidden while maximized. */}
      {!win.maximized && (
        <div
          onPointerDown={win.resizeHandlers.onPointerDown}
          onPointerMove={win.resizeHandlers.onPointerMove}
          onPointerUp={win.resizeHandlers.onPointerUp}
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          aria-hidden
        >
          <svg
            viewBox="0 0 10 10"
            className="h-full w-full text-[color:var(--fg-muted)]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          >
            <path d="M9 1 L1 9 M9 5 L5 9" />
          </svg>
        </div>
      )}
    </section>
  );
}
