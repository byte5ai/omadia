'use client';

import { useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { GitBranch, Maximize2, Minimize2, X } from 'lucide-react';

import type { PlanSnapshot } from '../_lib/chatSessions';
import { useFloatingWindow } from './useFloatingWindow';

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

/**
 * Floating "flying pane" for the live plan (anchored bottom-LEFT, the mirror of
 * the right-anchored {@link KgWalkPane}). A plan snapshot is just an ordered
 * step list, so the pane is a clean scrollable checklist — each row shows the
 * order number, the step goal (the semantics), and its status. Auto-opens when
 * a plan is fetched (new id) or extended (more steps), not on plain status
 * ticks. Window mechanics live in {@link useFloatingWindow}.
 */
export function PlanDagPane({ plan }: Props): React.ReactElement | null {
  const t = useTranslations('chat.planDag');
  const ts = useTranslations('planCard');
  const {
    open,
    maximized,
    style,
    openWindow,
    close,
    toggleMaximized,
    headerHandlers,
    resizeHandlers,
  } = useFloatingWindow({ anchor: 'left', defaultW: 440, defaultH: 640 });

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

      {/* Step list — the whole body. Ordered, scrollable, shows each goal. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 bg-neutral-950/95 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-500 backdrop-blur">
          {t('listHeader', { done: doneCount, total: totalSteps })}
        </div>
        <ul className="flex flex-col">
          {steps.map((s) => (
            <li
              key={s.stepExternalId}
              className={[
                'flex items-center gap-2.5 border-t border-white/5 px-3 py-2 text-[12px] transition hover:bg-white/5',
                s.status === 'in_progress' ? 'bg-amber-500/10' : '',
              ].join(' ')}
            >
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold text-neutral-950"
                style={{ backgroundColor: statusColor(s.status) }}
              >
                {s.order + 1}
              </span>
              <span
                className={[
                  'min-w-0 flex-1 truncate',
                  s.status === 'done'
                    ? 'text-neutral-400 line-through'
                    : s.status === 'skipped'
                      ? 'text-neutral-500'
                      : 'text-neutral-200',
                ].join(' ')}
                title={s.goal}
              >
                {s.goal}
              </span>
              <span
                className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px]"
                style={{
                  backgroundColor: `${statusColor(s.status)}26`,
                  color: statusColor(s.status),
                }}
              >
                {statusLabel(ts, s.status)}
              </span>
            </li>
          ))}
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
