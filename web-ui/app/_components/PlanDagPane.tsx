'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { GitBranch, Maximize2, Minimize2, X } from 'lucide-react';

import type { PlanSnapshot, PlanStepSnapshot } from '../_lib/chatSessions';
import { useFloatingWindow } from './useFloatingWindow';

const ForceGraph = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface Props {
  /** The live plan for the active turn; null hides the launcher. */
  plan: PlanSnapshot | null;
}

/** Per-status palette. Unknown statuses fall back to the neutral slate. */
const STATUS_COLORS: Record<string, string> = {
  pending: '#94a3b8',
  in_progress: '#f59e0b',
  done: '#34d399',
  failed: '#f87171',
  skipped: '#64748b',
};
const STATUS_FALLBACK = '#94a3b8';

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? STATUS_FALLBACK;
}

interface StepNodeDatum {
  id: string;
  order: number;
  goal: string;
  status: string;
  color: string;
}

interface StepLinkDatum {
  source: string;
  target: string;
  /** True when the link feeds the currently in-progress step (animated flow). */
  active: boolean;
}

function truncate(label: string, max = 40): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

/**
 * Floating "flying pane" visualization of the live plan DAG (anchored
 * bottom-LEFT, the mirror of the right-anchored {@link KgWalkPane}). The plan
 * snapshot is an ordered step list; we render it as a top-down DAG (sequential
 * edges) with status-colored nodes and a step list below. Auto-opens when a
 * plan is fetched (new id) or extended (more steps) — not on mere status ticks.
 * Window mechanics live in {@link useFloatingWindow}.
 */
export function PlanDagPane({ plan }: Props): React.ReactElement | null {
  const t = useTranslations('chat.planDag');
  const ts = useTranslations('planCard');
  // Destructure the hook return: the React Compiler (`react-hooks/refs`) treats
  // destructured hook values as plain reactive values, whereas member-access on
  // the returned object (`win.style`, …) trips the "ref accessed during render"
  // check because the object also exposes ref-closing callbacks.
  const {
    open,
    maximized,
    style,
    canvas,
    openWindow,
    close,
    toggleMaximized,
    setCanvasRef,
    headerHandlers,
    resizeHandlers,
  } = useFloatingWindow({ anchor: 'left', defaultW: 460, defaultH: 600 });
  const [activeStepId, setActiveStepId] = useState<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);

  const steps = useMemo(
    () => [...(plan?.steps ?? [])].sort((a, b) => a.order - b.order),
    [plan],
  );

  // Auto-open on FETCH (new plan id) or EXTEND (step-count change) — keyed on
  // that signature so a plain status transition doesn't reopen a pane the user
  // closed. Deferred a tick so the first client paint matches the SSR launcher.
  const planKey =
    plan && steps.length > 0
      ? `${plan.planExternalId}:${String(steps.length)}`
      : null;
  useEffect(() => {
    if (!planKey) return;
    const id = setTimeout(() => {
      openWindow();
    }, 0);
    return () => {
      clearTimeout(id);
    };
  }, [planKey, openWindow]);

  const data = useMemo((): {
    nodes: StepNodeDatum[];
    links: StepLinkDatum[];
  } => {
    const nodes: StepNodeDatum[] = steps.map((s) => ({
      id: s.stepExternalId,
      order: s.order,
      goal: s.goal,
      status: s.status,
      color: statusColor(s.status),
    }));
    const links: StepLinkDatum[] = [];
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1] as PlanStepSnapshot;
      const cur = steps[i] as PlanStepSnapshot;
      links.push({
        source: prev.stepExternalId,
        target: cur.stepExternalId,
        active: cur.status === 'in_progress',
      });
    }
    return { nodes, links };
  }, [steps]);

  // Re-fit the camera as the DAG layout settles / changes.
  const canvasW = canvas.w;
  const canvasH = canvas.h;
  useEffect(() => {
    if (!fgRef.current || canvasW === 0 || canvasH === 0) return;
    const id = setTimeout(() => {
      try {
        fgRef.current?.zoomToFit?.(400, 30);
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      clearTimeout(id);
    };
  }, [canvasW, canvasH, data.nodes.length]);

  const doneCount = useMemo(
    () => steps.filter((s) => s.status === 'done').length,
    [steps],
  );

  if (!plan || steps.length === 0) return null;

  const totalSteps = steps.length;

  // Launcher chip when the pane is closed.
  if (!open) {
    return (
      <button
        type="button"
        onClick={openWindow}
        className="fixed bottom-6 left-6 z-40 flex items-center gap-2 rounded-full border border-sky-300 bg-white/90 px-4 py-2 text-sm font-medium text-sky-700 shadow-lg backdrop-blur transition hover:bg-white dark:border-sky-700 dark:bg-neutral-900/90 dark:text-sky-300 dark:hover:bg-neutral-900"
        aria-label={t('openLabel')}
        title={t('openLabel')}
      >
        <GitBranch size={16} aria-hidden />
        {t('openLabel')}
        <span className="rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[10px] text-sky-700 dark:bg-sky-900/60 dark:text-sky-300">
          {doneCount}/{totalSteps}
        </span>
      </button>
    );
  }

  if (!style) return null;

  return (
    <section
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-neutral-300 bg-neutral-950 text-neutral-200 shadow-2xl dark:border-neutral-700"
      style={style}
      aria-label={t('title')}
    >
      <header
        onPointerDown={headerHandlers.onPointerDown}
        onPointerMove={headerHandlers.onPointerMove}
        onPointerUp={headerHandlers.onPointerUp}
        className={[
          'flex items-center justify-between gap-2 border-b border-white/10 bg-neutral-900 px-3 py-2 select-none',
          maximized ? '' : 'cursor-move',
        ].join(' ')}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-neutral-100">
            <GitBranch size={13} aria-hidden className="text-sky-400" />
            {t('title')}
          </span>
          <span className="truncate text-[10px] text-neutral-500">
            {t('subtitle')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="flex gap-1 font-mono text-[10px] text-neutral-400">
            <span className="rounded bg-white/10 px-1.5 py-0.5">
              {t('badgeProgress', { done: doneCount, total: totalSteps })}
            </span>
          </span>
          <button
            type="button"
            onClick={toggleMaximized}
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
            onClick={close}
            className="rounded p-1 text-neutral-400 transition hover:bg-white/10 hover:text-neutral-100"
            aria-label={t('close')}
            title={t('close')}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      </header>

      {/* DAG region — top-down hierarchical layout of the ordered steps. */}
      <div ref={setCanvasRef} className="relative min-h-0 flex-[3]">
        {canvasW > 0 && canvasH > 0 && (
          <ForceGraph
            ref={fgRef}
            graphData={data}
            width={canvasW}
            height={canvasH}
            backgroundColor="#0b1220"
            dagMode="td"
            dagLevelDistance={46}
            nodeRelSize={5}
            cooldownTicks={120}
            d3VelocityDecay={0.4}
            onEngineStop={() => {
              try {
                fgRef.current?.zoomToFit?.(400, 30);
              } catch {
                /* ignore */
              }
            }}
            onNodeHover={(node) => {
              setActiveStepId(node ? (node as StepNodeDatum).id : null);
            }}
            linkColor={(l) =>
              (l as StepLinkDatum).active
                ? 'rgba(245, 158, 11, 0.7)'
                : 'rgba(99, 102, 241, 0.4)'
            }
            linkWidth={(l) => ((l as StepLinkDatum).active ? 2.2 : 1.4)}
            linkDirectionalArrowLength={3.5}
            linkDirectionalArrowRelPos={1}
            linkDirectionalParticles={(l) =>
              (l as StepLinkDatum).active ? 3 : 0
            }
            linkDirectionalParticleWidth={2.4}
            linkDirectionalParticleColor={() => '#f59e0b'}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as StepNodeDatum & { x?: number; y?: number };
              const x = n.x ?? 0;
              const y = n.y ?? 0;
              const isActive = n.id === activeStepId;
              const inProgress = n.status === 'in_progress';
              const r = 6;

              // Ring: in-progress gets an amber halo; hovered gets a gold ring;
              // done/failed get a subtle status-colored ring.
              if (inProgress || isActive) {
                ctx.beginPath();
                ctx.arc(x, y, r + 4, 0, 2 * Math.PI);
                ctx.strokeStyle = isActive ? '#fbbf24' : '#f59e0b';
                ctx.lineWidth = 2.4;
                ctx.stroke();
              }

              ctx.fillStyle = n.color;
              ctx.beginPath();
              ctx.arc(x, y, r, 0, 2 * Math.PI);
              ctx.fill();

              // Order number centered in the disc.
              const numFont = 8 / globalScale;
              ctx.fillStyle = '#0b1220';
              ctx.font = `600 ${String(numFont)}px system-ui, sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(String(n.order + 1), x, y);

              // Goal label to the right — the SEMANTIC content, always shown.
              const fontSize = 10 / globalScale;
              ctx.fillStyle = isActive ? '#fde68a' : '#e2e8f0';
              ctx.font = `${String(fontSize)}px system-ui, sans-serif`;
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(truncate(n.goal, 28), x + r + 4, y);
            }}
          />
        )}

        {/* Status legend, bottom-left of the canvas. */}
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-black/40 px-2 py-1 text-[10px] text-neutral-300 backdrop-blur-sm">
          {(['in_progress', 'done', 'pending', 'failed'] as const).map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: statusColor(s) }}
              />
              {statusLabel(ts, s)}
            </span>
          ))}
        </div>
      </div>

      {/* Step list — ordered, scrollable, shows the goal (semantics). */}
      <div className="min-h-0 flex-[2] overflow-y-auto border-t border-white/10 bg-neutral-900/60">
        <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
          {t('listHeader', { done: doneCount, total: totalSteps })}
        </div>
        <ul className="flex flex-col">
          {steps.map((s) => {
            const isActive = s.stepExternalId === activeStepId;
            return (
              <li
                key={s.stepExternalId}
                onMouseEnter={() => {
                  setActiveStepId(s.stepExternalId);
                }}
                onMouseLeave={() => {
                  setActiveStepId(null);
                }}
                className={[
                  'flex items-center gap-2 border-t border-white/5 px-3 py-1.5 text-[11px]',
                  isActive ? 'bg-white/10' : 'hover:bg-white/5',
                ].join(' ')}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full font-mono text-[9px] text-neutral-950" style={{ backgroundColor: statusColor(s.status) }}>
                  {s.order + 1}
                </span>
                <span
                  className={[
                    'truncate',
                    s.status === 'done'
                      ? 'text-neutral-400 line-through'
                      : 'text-neutral-200',
                  ].join(' ')}
                  title={s.goal}
                >
                  {s.goal}
                </span>
                <span
                  className="ml-auto shrink-0 rounded px-1 py-0.5 font-mono text-[9px]"
                  style={{
                    backgroundColor: `${statusColor(s.status)}26`,
                    color: statusColor(s.status),
                  }}
                >
                  {statusLabel(ts, s.status)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Resize handle (bottom-right corner). Hidden while maximized. */}
      {!maximized && (
        <div
          onPointerDown={resizeHandlers.onPointerDown}
          onPointerMove={resizeHandlers.onPointerMove}
          onPointerUp={resizeHandlers.onPointerUp}
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

/** Map a plan status to its localized label, reusing the planCard namespace. */
function statusLabel(
  ts: ReturnType<typeof useTranslations>,
  status: string,
): string {
  switch (status) {
    case 'pending':
      return ts('statusPending');
    case 'in_progress':
      return ts('statusInProgress');
    case 'done':
      return ts('statusDone');
    case 'failed':
      return ts('statusFailed');
    case 'skipped':
      return ts('statusSkipped');
    default:
      return status;
  }
}
