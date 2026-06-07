'use client';

import dynamic from 'next/dynamic';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { Maximize2, Minimize2, Network, X } from 'lucide-react';

import type { KgWalkPayload } from '../_lib/chatSessions';

// react-force-graph-2d touches `window`/canvas at import time, so it must be
// client-only. Ported from dk-intelligent-core's GraphPanel.
const ForceGraph = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface Props {
  /** The KG-walk this assistant turn surfaced; null hides the launcher. */
  walk: KgWalkPayload | null;
}

/** Accent for roots + traversed edges. Matches the chat's indigo phase pill. */
const ROOT_ACCENT = '#6366f1';

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

/** Default + bounds for the floating pane geometry. */
const DEFAULT_W = 560;
const DEFAULT_H = 640;
const MIN_W = 360;
const MIN_H = 360;
const VIEWPORT_MARGIN = 16; // px gap kept from each viewport edge.

interface GraphNodeDatum {
  id: string;
  name: string;
  kind: string;
  color: string;
  isRoot: boolean;
  hop: number;
  score?: number;
}

interface GraphLinkDatum {
  source: string;
  target: string;
  type: string;
  hop: number;
}

function truncateLabel(label: string, max = 24): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface PaneGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bottom-right default anchor, clamped to the current viewport. */
function defaultGeom(): PaneGeom {
  if (typeof window === 'undefined') {
    return { x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(DEFAULT_W, vw - VIEWPORT_MARGIN * 2);
  const h = Math.min(DEFAULT_H, vh - VIEWPORT_MARGIN * 2);
  return {
    x: Math.max(VIEWPORT_MARGIN, vw - w - VIEWPORT_MARGIN),
    y: Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN),
    w,
    h,
  };
}

/**
 * Floating "flying pane" visualization of the knowledge-graph neighborhood a
 * turn walked. Replaces the old fixed right-rail sidebar. A launcher chip opens
 * a draggable / resizable / maximizable window with a de-noised force graph on
 * top and a hop-by-hop details list below.
 */
export function KgWalkPane({ walk }: Props): React.ReactElement | null {
  const t = useTranslations('chat.kgWalk');
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [geom, setGeom] = useState<PaneGeom | null>(null);
  /** id of the node currently hovered (in graph or list) for cross-highlight. */
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [canvas, setCanvas] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
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

  // Open the pane, seeding geometry from the live viewport on first open so it
  // anchors bottom-right and stays within bounds. Done in the handler (not an
  // effect) to avoid a setState-in-effect cascade.
  const openPane = useCallback(() => {
    setGeom((prev) => prev ?? defaultGeom());
    setOpen(true);
  }, []);

  // Hop-reveal timer — settles quickly so the user isn't blocked.
  useEffect(() => {
    if (!open || !walk || maxHop === 0) return;
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
  }, [open, walk, maxHop]);

  const setCanvasRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!el) {
      setCanvas({ w: 0, h: 0 });
      return;
    }
    const measure = (): void => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setCanvas((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
  }, []);

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

  const rootSet = useMemo(
    () => new Set<string>(walk?.rootIds ?? []),
    [walk],
  );

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
      ...(n.score !== undefined ? { score: n.score } : {}),
    }));
    const links: GraphLinkDatum[] = walk.edges.map((e) => ({
      source: e.from,
      target: e.to,
      type: e.type,
      hop: e.hop,
    }));
    return { nodes, links };
  }, [walk, nodeHopById, rootSet]);

  // De-noise force tuning: long links + strong repulsion + collision so the
  // nodes spread out instead of piling up. Applied once the sim mounts.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || data.nodes.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        // d3-force-3d is force-graph's own simulation engine; reuse its
        // forceCollide so node discs + rings never overlap (the main
        // contributor to the old label pile-up).
        const { forceCollide } = await import('d3-force-3d');
        if (cancelled || !fgRef.current) return;
        fgRef.current.d3Force('charge')?.strength(-280);
        fgRef.current.d3Force('link')?.distance(75);
        fgRef.current.d3Force('collide', forceCollide(18));
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
  useEffect(() => {
    if (!fgRef.current || canvas.w === 0 || canvas.h === 0) return;
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
  }, [canvas.w, canvas.h, data.nodes.length]);

  // --- Drag handling (header) ---------------------------------------------
  const dragState = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (maximized || !geom) return;
      // Don't start a drag from the control buttons.
      if ((e.target as HTMLElement).closest('button')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: geom.x,
        originY: geom.y,
      };
    },
    [maximized, geom],
  );

  const onHeaderPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const st = dragState.current;
      if (!st) return;
      setGeom((prev) => {
        if (!prev) return prev;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const nextX = clamp(
          st.originX + (e.clientX - st.startX),
          VIEWPORT_MARGIN,
          Math.max(VIEWPORT_MARGIN, vw - prev.w - VIEWPORT_MARGIN),
        );
        const nextY = clamp(
          st.originY + (e.clientY - st.startY),
          VIEWPORT_MARGIN,
          Math.max(VIEWPORT_MARGIN, vh - prev.h - VIEWPORT_MARGIN),
        );
        return { ...prev, x: nextX, y: nextY };
      });
    },
    [],
  );

  const onHeaderPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      dragState.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  // --- Resize handling (corner handle) ------------------------------------
  const resizeState = useRef<{
    startX: number;
    startY: number;
    originW: number;
    originH: number;
  } | null>(null);

  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      if (maximized || !geom) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      resizeState.current = {
        startX: e.clientX,
        startY: e.clientY,
        originW: geom.w,
        originH: geom.h,
      };
    },
    [maximized, geom],
  );

  const onResizePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      const st = resizeState.current;
      if (!st) return;
      setGeom((prev) => {
        if (!prev) return prev;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const maxW = vw - prev.x - VIEWPORT_MARGIN;
        const maxH = vh - prev.y - VIEWPORT_MARGIN;
        const nextW = clamp(st.originW + (e.clientX - st.startX), MIN_W, maxW);
        const nextH = clamp(st.originH + (e.clientY - st.startY), MIN_H, maxH);
        return { ...prev, w: nextW, h: nextH };
      });
    },
    [],
  );

  const onResizePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>): void => {
      resizeState.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [],
  );

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

  // Launcher chip when the pane is closed.
  if (!open) {
    return (
      <button
        type="button"
        onClick={openPane}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full border border-indigo-300 bg-white/90 px-4 py-2 text-sm font-medium text-indigo-700 shadow-lg backdrop-blur transition hover:bg-white dark:border-indigo-700 dark:bg-neutral-900/90 dark:text-indigo-300 dark:hover:bg-neutral-900"
        aria-label={t('openLabel')}
        title={t('openLabel')}
      >
        <Network size={16} aria-hidden />
        {t('openLabel')}
        <span className="rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300">
          {totalNodes}
        </span>
      </button>
    );
  }

  // While geometry is being seeded on first open.
  if (!geom) return null;

  const style: React.CSSProperties = maximized
    ? {
        left: '5vw',
        top: '7.5vh',
        width: '90vw',
        height: '85vh',
      }
    : {
        left: geom.x,
        top: geom.y,
        width: geom.w,
        height: geom.h,
        maxWidth: `calc(100vw - ${String(VIEWPORT_MARGIN * 2)}px)`,
        maxHeight: `calc(100vh - ${String(VIEWPORT_MARGIN * 2)}px)`,
      };

  return (
    <section
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-neutral-300 bg-neutral-950 text-neutral-200 shadow-2xl dark:border-neutral-700"
      style={style}
      aria-label={t('title')}
    >
      <header
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        className={[
          'flex items-center justify-between gap-2 border-b border-white/10 bg-neutral-900 px-3 py-2 select-none',
          maximized ? '' : 'cursor-move',
        ].join(' ')}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-neutral-100">
            <Network size={13} aria-hidden className="text-indigo-400" />
            {t('title')}
          </span>
          <span className="truncate text-[10px] text-neutral-500">
            {t('subtitle')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="flex gap-1 font-mono text-[10px] text-neutral-400">
            <span className="rounded bg-white/10 px-1.5 py-0.5">
              {t('badgeNodes', { count: totalNodes })}
            </span>
            <span className="rounded bg-white/10 px-1.5 py-0.5">
              {t('badgeHops', { count: maxHop })}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              setMaximized((m) => !m);
            }}
            className="rounded p-1 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
            aria-label={maximized ? t('restore') : t('maximize')}
            title={maximized ? t('restore') : t('maximize')}
          >
            {maximized ? (
              <Minimize2 size={14} aria-hidden />
            ) : (
              <Maximize2 size={14} aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            className="rounded p-1 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
            aria-label={t('close')}
            title={t('close')}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      </header>

      {/* Graph region — fills the top, leaving the list a flexible share. */}
      <div ref={setCanvasRef} className="relative min-h-0 flex-[3]">
        {canvas.w > 0 && canvas.h > 0 && (
          <ForceGraph
            ref={fgRef}
            graphData={data}
            width={canvas.w}
            height={canvas.h}
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
              setActiveNodeId(
                node ? (node as GraphNodeDatum).id : null,
              );
            }}
            linkColor={(l) =>
              (l as GraphLinkDatum).hop <= revealedHop
                ? 'rgba(99, 102, 241, 0.45)'
                : 'rgba(99, 102, 241, 0.08)'
            }
            linkWidth={1.4}
            linkLabel={(l) => (l as GraphLinkDatum).type}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            linkDirectionalParticles={(l) =>
              (l as GraphLinkDatum).hop <= revealedHop ? 1 : 0
            }
            linkDirectionalParticleWidth={1.8}
            linkDirectionalParticleColor={() => ROOT_ACCENT}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as GraphNodeDatum & { x?: number; y?: number };
              const x = n.x ?? 0;
              const y = n.y ?? 0;
              const revealed = n.hop <= revealedHop;
              const isActive = n.id === activeNodeId;
              const r = n.isRoot ? 6.5 : 4;
              ctx.globalAlpha = revealed ? 1 : 0.18;

              // Ring: roots keep the accent ring; active node gets a halo.
              if (n.isRoot || isActive) {
                ctx.beginPath();
                ctx.arc(x, y, r + 3.5, 0, 2 * Math.PI);
                ctx.strokeStyle = isActive ? '#fbbf24' : ROOT_ACCENT;
                ctx.lineWidth = isActive ? 2.5 : 2;
                ctx.stroke();
              }

              ctx.fillStyle = n.color;
              ctx.beginPath();
              ctx.arc(x, y, r, 0, 2 * Math.PI);
              ctx.fill();

              // DE-NOISE: only roots + the hovered node carry a readable
              // label by default; everyone else stays unlabeled (or appears
              // when zoomed in past a threshold). This kills the overlap.
              const zoomedIn = globalScale > 2.2;
              const showLabel =
                revealed && (n.isRoot || isActive || zoomedIn);
              if (showLabel) {
                const fontSize = 11 / globalScale;
                ctx.fillStyle = isActive ? '#fde68a' : '#e2e8f0';
                ctx.font = `${String(fontSize)}px system-ui, sans-serif`;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(truncateLabel(n.name), x + r + 3, y);
              }
              ctx.globalAlpha = 1;
            }}
          />
        )}

        {/* Minimal legend, bottom-left of the canvas. */}
        <div className="pointer-events-none absolute bottom-2 left-2 flex gap-3 rounded-md bg-black/40 px-2 py-1 text-[10px] text-neutral-300 backdrop-blur-sm">
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
        </div>
      </div>

      {/* Hop-details list — scrollable, grouped by hop. */}
      <div className="min-h-0 flex-[2] overflow-y-auto border-t border-white/10 bg-neutral-900/60">
        <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
          {t('hopListHeader', { nodes: totalNodes, hops: maxHop })}
        </div>
        {hopGroups.map((group) => (
          <div key={group.hop} className="border-t border-white/5 px-3 py-1.5">
            <div className="mb-1 text-[11px] font-semibold text-indigo-300">
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
                    <span className="shrink-0 rounded bg-white/10 px-1 py-0.5 font-mono text-[9px] text-neutral-400">
                      {n.kind}
                    </span>
                    <span
                      className="truncate text-neutral-200"
                      title={n.name}
                    >
                      {truncateLabel(n.name, 40)}
                    </span>
                    {n.isRoot && n.score !== undefined && (
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-emerald-400">
                        {n.score.toFixed(2)}
                      </span>
                    )}
                    {!n.isRoot && incoming && (
                      <span
                        className="ml-auto shrink-0 truncate font-mono text-[9px] text-neutral-500"
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
      {!maximized && (
        <div
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          aria-hidden
        >
          <svg
            viewBox="0 0 10 10"
            className="h-full w-full text-neutral-500"
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
