'use client';

import { useCallback, useRef } from 'react';

import { useReducedMotion } from 'framer-motion';
import { useTranslations } from 'next-intl';

import type { DevJobStatus, DevJobView } from '@/app/admin/dev-platform/_lib/api';

/**
 * Epic #470 — the pipeline phase rail, the epic's one signature element
 * (UI spec §5). A `role="tablist"` of the eight stops
 * `analyze → bootstrap → plan → clarify → gate → implement → review → pr`
 * (`gate` is the UI name for the backend `await_human` phase; `bootstrap` is
 * dependency install). State is edge + text only — no fills, no pulsing dots.
 *
 * Two distinct notions are kept visually and semantically apart (§5/§13):
 *   - the pipeline's CURRENT phase → `aria-current="step"`, accent edge;
 *   - the VIEWED phase → `aria-selected`, `--fg-strong` + `--border-strong` edge.
 * Rail selection writes `?phase=` (deep-linkable) via `onSelect`.
 *
 * Keyboard (§13): roving tabindex; Left/Right move between stops, Home/End jump,
 * Enter/Space selects. Future stops are focusable-but-`aria-disabled` so their
 * `title` explanation stays reachable; selecting one is a no-op (no artifact
 * yet). `prefers-reduced-motion` is honoured by using a static per-stop edge —
 * there is no sliding element to animate.
 */

export type DevJobUiPhase =
  | 'analyze'
  | 'bootstrap'
  | 'plan'
  | 'clarify'
  | 'gate'
  | 'implement'
  | 'review'
  | 'pr';

export type PhaseStopState = 'completed' | 'current' | 'skipped' | 'future' | 'failed';

export interface PhaseStop {
  phase: DevJobUiPhase;
  state: PhaseStopState;
}

/** Canonical stop order. `gate` maps to the backend `await_human` phase. */
export const DEV_JOB_UI_PHASES: readonly DevJobUiPhase[] = [
  'analyze',
  'bootstrap',
  'plan',
  'clarify',
  'gate',
  'implement',
  'review',
  'pr',
];

/** Map a persisted `dev_jobs.phase` value to its UI stop. */
export function phaseToUi(phase: string): DevJobUiPhase {
  if (phase === 'await_human') return 'gate';
  return (DEV_JOB_UI_PHASES as readonly string[]).includes(phase)
    ? (phase as DevJobUiPhase)
    : 'implement';
}

/**
 * Derive each stop's state from a job view. W0 runs collapsed on `implement`
 * and ships no per-phase artifacts, so future stops are all disabled; W2 fills
 * this in. A failed job marks its pipeline stop `failed`; a done job marks every
 * stop up to `pr` complete.
 */
export function computePhaseStops(job: Pick<DevJobView, 'phase' | 'status'>): {
  stops: PhaseStop[];
  current: DevJobUiPhase;
} {
  const failed = job.status === 'failed' || job.status === 'stalled' || job.status === 'budget_exceeded';
  const done = job.status === 'done';
  const pipeline: DevJobUiPhase = done ? 'pr' : phaseToUi(job.phase);
  const currentIdx = DEV_JOB_UI_PHASES.indexOf(pipeline);
  const stops: PhaseStop[] = DEV_JOB_UI_PHASES.map((phase, idx) => {
    let state: PhaseStopState;
    if (idx < currentIdx) state = 'completed';
    else if (idx === currentIdx) state = done ? 'completed' : failed ? 'failed' : 'current';
    else state = 'future';
    return { phase, state };
  });
  return { stops, current: pipeline };
}

const STATE_TEXT: Record<PhaseStopState, string> = {
  completed: 'text-[color:var(--fg-muted)]',
  current: 'text-[color:var(--accent)]',
  skipped: 'text-[color:var(--fg-subtle)] line-through',
  future: 'text-[color:var(--fg-disabled)]',
  failed: 'text-[color:var(--danger)]',
};

export function DevJobPhaseRail({
  stops,
  current,
  selected,
  onSelect,
  live = false,
  compact = false,
}: {
  stops: PhaseStop[];
  /** The pipeline's current phase — gets `aria-current="step"`. */
  current: DevJobUiPhase;
  /** The phase the operator is viewing — gets `aria-selected`. */
  selected: DevJobUiPhase | null;
  onSelect: (phase: DevJobUiPhase) => void;
  /** While the runner is live the current stop carries `.lume-busy-dots`. */
  live?: boolean;
  /** Compact single-glyph rail (W3 chat card). */
  compact?: boolean;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.detail.phases');
  const tSkip = useTranslations('adminDevPlatform.detail');
  const reduce = useReducedMotion();
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isDisabled = (s: PhaseStop): boolean => s.state === 'future';

  // The roving-tabindex owner: the viewed stop, else the current stop.
  const activeIndex = Math.max(
    0,
    stops.findIndex((s) => s.phase === (selected ?? current)),
  );

  const focusStop = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(idx, btnRefs.current.length - 1));
    btnRefs.current[clamped]?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent, idx: number) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          focusStop(idx + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          focusStop(idx - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusStop(0);
          break;
        case 'End':
          e.preventDefault();
          focusStop(stops.length - 1);
          break;
        case 'Enter':
        case ' ': {
          e.preventDefault();
          const stop = stops[idx];
          if (stop && !isDisabled(stop)) onSelect(stop.phase);
          break;
        }
        default:
          break;
      }
    },
    [focusStop, onSelect, stops],
  );

  if (compact) {
    // W3 compact rail: one glyph per stop, title carries the phase name.
    const glyph = (s: PhaseStop): string =>
      s.state === 'completed' ? '✓' : s.state === 'current' ? '●' : s.state === 'skipped' ? '–' : s.state === 'failed' ? '✕' : '·';
    return (
      <span className="font-mono text-xs" role="img" aria-label={t(current)}>
        {stops.map((s) => (
          <span key={s.phase} title={t(s.phase)} className={`mr-0.5 ${STATE_TEXT[s.state]}`}>
            {glyph(s)}
          </span>
        ))}
      </span>
    );
  }

  return (
    <div className="overflow-x-auto">
      <div role="tablist" aria-label={tSkip('railLabel')} className="flex min-w-max items-center gap-1 py-2">
        {stops.map((s, idx) => {
          const disabled = isDisabled(s);
          const isCurrent = s.phase === current;
          const isViewed = selected !== null && s.phase === selected;
          const edge =
            s.state === 'failed'
              ? 'border-b-2 border-[color:var(--danger-edge)]'
              : isViewed && !isCurrent
                ? 'border-b-2 border-[color:var(--border-strong)]'
                : isCurrent
                  ? 'border-b-2 border-[color:var(--accent)]'
                  : 'border-b-2 border-transparent';
          const viewedText = isViewed && !isCurrent ? 'text-[color:var(--fg-strong)]' : STATE_TEXT[s.state];
          return (
            <div key={s.phase} className="flex items-center">
              {idx > 0 ? (
                <span
                  aria-hidden
                  className={`h-px w-4 ${idx <= activeIndex ? 'bg-[color:var(--border-strong)]' : 'bg-[color:var(--divider)]'}`}
                />
              ) : null}
              <button
                type="button"
                role="tab"
                ref={(el) => {
                  btnRefs.current[idx] = el;
                }}
                tabIndex={idx === activeIndex ? 0 : -1}
                aria-selected={isViewed}
                aria-current={isCurrent ? 'step' : undefined}
                aria-disabled={disabled || undefined}
                title={s.state === 'skipped' ? tSkip('phaseSkipped') : t(s.phase)}
                onClick={() => {
                  if (!disabled) onSelect(s.phase);
                }}
                onKeyDown={(e) => onKeyDown(e, idx)}
                className={`px-2 py-1 text-[13px] uppercase tracking-[0.18em] outline-none focus-visible:text-[color:var(--accent)] ${edge} ${viewedText} ${
                  reduce ? '' : 'transition-colors'
                } ${disabled ? 'cursor-default' : 'cursor-pointer'}`}
              >
                {s.state === 'completed' ? <span aria-hidden>✓ </span> : null}
                {t(s.phase)}
                {isCurrent && live ? <span className="lume-busy-dots" aria-hidden /> : null}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Convenience: does this status mean the runner is live (busy dots on rail)? */
export function statusIsLive(status: DevJobStatus): boolean {
  return status === 'provisioning' || status === 'running' || status === 'applying';
}
