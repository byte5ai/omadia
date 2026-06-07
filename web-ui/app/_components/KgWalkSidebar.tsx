'use client';

import dynamic from 'next/dynamic';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';

import type { KgWalkPayload } from '../_lib/chatSessions';

// react-force-graph-2d touches `window`/canvas at import time, so it must be
// client-only. Ported from dk-intelligent-core's GraphPanel.
const ForceGraph = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface Props {
  /** The KG-walk this assistant turn surfaced; null collapses the rail. */
  walk: KgWalkPayload | null;
}

/** Accent for roots + traversed edges. Matches the chat's indigo phase pill. */
const ROOT_ACCENT = '#6366f1';
/** Discovered-neighbor ring. */
const NEIGHBOR_ACCENT = '#fbbf24';

/** Per-kind fill. Roots (MemorableKnowledge) lean accent; neighbors muted. */
const KIND_COLORS: Record<string, string> = {
  MemorableKnowledge: '#818cf8',
  Turn: '#34d399',
  Entity: '#94a3b8',
  User: '#f472b6',
};

/** Delay between hop reveals, ms. */
const HOP_INTERVAL_MS = 650;

interface GraphNodeDatum {
  id: string;
  name: string;
  kind: string;
  color: string;
  isRoot: boolean;
  hop: number;
}

interface GraphLinkDatum {
  source: string;
  target: string;
  type: string;
  hop: number;
}

/**
 * Right-rail visualization of the knowledge-graph neighborhood a turn walked.
 * Progressively reveals the graph hop-by-hop (roots first, then hop-1 edges +
 * their nodes, then hop-2, …) to convey the "iterating through the KG" effect.
 * Re-runs the animation whenever `walk` changes (i.e. on a new turn).
 */
export function KgWalkSidebar({ walk }: Props): React.ReactElement | null {
  const t = useTranslations('chat.kgWalk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [revealedHop, setRevealedHop] = useState(0);
  // Track the walk currently being animated so a new turn resets the cursor
  // via React's "adjust state during render" pattern — no setState in effects.
  const [animatedWalk, setAnimatedWalk] = useState<KgWalkPayload | null>(walk);

  const maxHop = useMemo(() => {
    if (!walk) return 0;
    return walk.edges.reduce((acc, e) => Math.max(acc, e.hop), 0);
  }, [walk]);

  if (animatedWalk !== walk) {
    setAnimatedWalk(walk);
    setRevealedHop(0);
  }

  // Hop-reveal timer. Each tick steps the cursor up one hop until maxHop is
  // reached, producing the "iterating through the KG" effect.
  useEffect(() => {
    if (!walk || maxHop === 0) return;
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
  }, [walk, maxHop]);

  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!el) {
      setDims({ w: 0, h: 0 });
      return;
    }
    const measure = (): void => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setDims((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    roRef.current = ro;
  }, []);

  // Map each node to the smallest hop at which it becomes reachable. Roots are
  // hop 0; a node's hop is the min hop of any incident edge.
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
    // Nodes not touched by any edge and not a root default to hop 0 so they
    // still render (defensive against partial payloads).
    if (walk.nodes) {
      for (const n of walk.nodes) {
        if (!map.has(n.id)) map.set(n.id, 0);
      }
    }
    return map;
  }, [walk]);

  const rootSet = useMemo(
    () => new Set<string>(walk?.rootIds ?? []),
    [walk],
  );

  // Build the graph data limited to what's been revealed so far. Recomputed as
  // `revealedHop` steps up, which feeds new nodes/links into ForceGraph.
  const data = useMemo((): {
    nodes: GraphNodeDatum[];
    links: GraphLinkDatum[];
  } => {
    if (!walk) return { nodes: [], links: [] };
    const visibleNodeIds = new Set<string>();
    for (const [id, hop] of nodeHopById) {
      if (hop <= revealedHop) visibleNodeIds.add(id);
    }
    const nodes: GraphNodeDatum[] = walk.nodes
      .filter((n) => visibleNodeIds.has(n.id))
      .map((n) => ({
        id: n.id,
        name: n.label,
        kind: n.kind,
        color: KIND_COLORS[n.kind] ?? '#94a3b8',
        isRoot: rootSet.has(n.id),
        hop: nodeHopById.get(n.id) ?? 0,
      }));
    const links: GraphLinkDatum[] = walk.edges
      .filter(
        (e) =>
          e.hop <= revealedHop &&
          visibleNodeIds.has(e.from) &&
          visibleNodeIds.has(e.to),
      )
      .map((e) => ({
        source: e.from,
        target: e.to,
        type: e.type,
        hop: e.hop,
      }));
    return { nodes, links };
  }, [walk, nodeHopById, rootSet, revealedHop]);

  // Re-fit the camera as nodes stream in across hops.
  useEffect(() => {
    if (!fgRef.current || dims.w === 0 || dims.h === 0) return;
    const t0 = setTimeout(() => {
      try {
        fgRef.current?.zoomToFit?.(400, 24);
      } catch {
        /* ignore */
      }
    }, 150);
    return () => {
      clearTimeout(t0);
    };
  }, [dims.w, dims.h, data.nodes.length, data.links.length]);

  if (!walk) return null;

  const totalNodes = walk.nodes.length;
  const revealing = revealedHop < maxHop;

  return (
    <aside
      className="flex w-full flex-col overflow-hidden rounded-lg border border-neutral-200 bg-neutral-950 text-neutral-200 shadow-sm dark:border-neutral-800"
      aria-label={t('title')}
    >
      <header className="flex flex-col gap-0.5 border-b border-white/10 px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wide text-neutral-100">
            {t('title')}
          </span>
          <span className="flex gap-1 font-mono text-[10px] text-neutral-400">
            <span className="rounded bg-white/10 px-1.5 py-0.5">
              {t('badgeNodes', { count: totalNodes })}
            </span>
            <span className="rounded bg-white/10 px-1.5 py-0.5">
              {t('badgeHops', { count: maxHop })}
            </span>
          </span>
        </div>
        <span className="text-[10px] text-neutral-500">{t('subtitle')}</span>
      </header>

      <div ref={setContainerRef} className="relative h-64 w-full">
        {dims.w > 0 && dims.h > 0 && (
          <ForceGraph
            ref={fgRef}
            graphData={data}
            width={dims.w}
            height={dims.h}
            backgroundColor="#0b1220"
            nodeRelSize={5}
            nodeLabel="name"
            cooldownTicks={90}
            onEngineStop={() => {
              try {
                fgRef.current?.zoomToFit?.(400, 24);
              } catch {
                /* ignore */
              }
            }}
            linkColor={() => 'rgba(99, 102, 241, 0.45)'}
            linkWidth={1.4}
            linkLabel={(l) => (l as GraphLinkDatum).type}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            linkDirectionalParticles={2}
            linkDirectionalParticleWidth={2.2}
            linkDirectionalParticleColor={() => ROOT_ACCENT}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as GraphNodeDatum & { x?: number; y?: number };
              const x = n.x ?? 0;
              const y = n.y ?? 0;
              const label = n.name ?? '';
              const fontSize = 10 / globalScale;
              const r = n.isRoot ? 5.5 : 3.5;

              // Ring: roots get the accent, discovered neighbors get amber.
              ctx.beginPath();
              ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
              ctx.strokeStyle = n.isRoot ? ROOT_ACCENT : NEIGHBOR_ACCENT;
              ctx.lineWidth = n.isRoot ? 2 : 1.3;
              ctx.stroke();

              ctx.fillStyle = n.color;
              ctx.beginPath();
              ctx.arc(x, y, r, 0, 2 * Math.PI);
              ctx.fill();

              ctx.fillStyle = '#e2e8f0';
              ctx.font = `${String(fontSize)}px system-ui, sans-serif`;
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(label.slice(0, 24), x + 7, y);
            }}
          />
        )}

        {revealing && (
          <div className="pointer-events-none absolute left-2 top-2 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2 py-1 font-mono text-[10px] text-indigo-300 backdrop-blur-sm">
            {t('revealing', { current: revealedHop, total: maxHop })}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-3 border-t border-white/10 px-3 py-1.5 text-[10px] text-neutral-400">
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
            className="inline-block h-2 w-2 rounded-full ring-2 ring-[#fbbf24]"
            style={{ backgroundColor: '#94a3b8' }}
          />
          {t('legendNeighbors')}
        </span>
      </footer>
    </aside>
  );
}
