'use client';

import { AlertTriangle } from 'lucide-react';

import { cn } from '../../../../_lib/cn';
import type { ConflictSeverity } from '../../../../_lib/personaConflicts';

/**
 * Phase 3 / OB-67 Slice 3 — single 0–100 axis slider.
 *
 * One axis = one slider; the parent (PersonaPillar) renders 12 instances
 * via CORE_PERSONA_AXES + EXTENDED_PERSONA_AXES. Custom on top of
 * `<input type="range">` (no @radix-ui per persona-ui-v1.md §13.1) —
 * Tailwind v4's arbitrary-variant syntax styles the thumb directly.
 *
 * `baseValue` (model-family default, optional) renders as a small dot on
 * the track — a visual hint to operators about how far the persona
 * deviates from neutral. Phase 4 (`harness-persona`) supplies real
 * family defaults; Phase 3 leaves the prop unset (no dot).
 *
 * `warning` flips the inline AlertTriangle + label colour: soft uses
 * `--warning`, hard uses `--danger`. The actual conflict-banner lives at
 * pillar level (ConflictBanner); this inline marker only points to the
 * banner so operators don't have to scroll to find which slider is
 * involved.
 */

export interface DimensionSliderProps {
  /** Stable axis id (e.g. "directness"). Used as label for a11y. */
  axis: string;
  /** Left-end semantic anchor, e.g. "DIPLOMATIC". */
  labelLeft: string;
  /** Right-end semantic anchor, e.g. "DIRECT". */
  labelRight: string;
  /** Optional one-line description; rendered as the slider's title hint. */
  description?: string;
  /** Current value 0–100 (controlled). */
  value: number;
  onChange: (next: number) => void;
  /** Optional model-family default (rendered as a tick on the track). */
  baseValue?: number;
  /** Inline warning marker — soft = warning-tone, hard = danger-tone.
   *  Pillar passes the severity from `detectPersonaConflicts`. */
  warning?: ConflictSeverity;
  /** Disable interaction (useful when the draft is read-only / locked). */
  disabled?: boolean;
}

export function DimensionSlider({
  axis,
  labelLeft,
  labelRight,
  description,
  value,
  onChange,
  baseValue,
  warning,
  disabled,
}: DimensionSliderProps): React.ReactElement {
  // Clamp the value-bubble's horizontal anchor so it doesn't escape the
  // track at 0% / 100%. 4% on each side keeps the badge fully visible
  // without drifting noticeably from the thumb in the middle 90% of the
  // track (where it matters most).
  const bubbleLeftPct = Math.max(4, Math.min(96, value));

  return (
    <div className="space-y-1" data-testid={`dimension-slider-${axis}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {labelLeft}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {labelRight}
        </span>
      </div>
      <div className="relative pt-5">
        <span
          className={cn(
            'pointer-events-none absolute top-0 z-10 -translate-x-1/2',
            'rounded-md border border-[color:var(--border)] bg-[color:var(--bg-elevated)]',
            'px-1.5 py-0.5 font-mono-num tabular-nums text-[10px] text-[color:var(--fg-strong)]',
            'shadow-[var(--shadow-sm)]',
          )}
          style={{ left: `${bubbleLeftPct}%` }}
          aria-label={`${axis} value`}
        >
          {value}
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          disabled={disabled}
          aria-label={`${axis}: ${labelLeft} to ${labelRight}`}
          {...(description ? { title: description } : {})}
          className={cn(
            'w-full appearance-none bg-[color:var(--border)] rounded-full h-1.5',
            'accent-[color:var(--accent)]',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]',
          )}
        />
        {typeof baseValue === 'number' ? (
          <span
            className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--fg-subtle)]"
            style={{ left: `${baseValue}%`, top: 'calc(1.25rem + 0.1875rem)' }}
            aria-hidden
            title={`Modell-Default: ${baseValue}`}
            data-testid={`dimension-slider-${axis}-base-tick`}
          />
        ) : null}
      </div>
      {warning ? (
        <div
          className={cn(
            'flex items-center gap-1.5 text-[11px]',
            warning === 'hard'
              ? 'text-[color:var(--danger)]'
              : 'text-[color:var(--warning)]',
          )}
          data-testid={`dimension-slider-${axis}-warning`}
        >
          <AlertTriangle className="size-3.5" aria-hidden />
          <span>Konflikt — siehe Banner.</span>
        </div>
      ) : null}
    </div>
  );
}
