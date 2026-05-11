'use client';

import { useId } from 'react';

import { cn } from '../../../../_lib/cn';
import {
  ALL_PERSONA_AXES,
  PERSONA_AXIS_LABELS,
  PERSONA_AXIS_NEUTRAL,
  type PersonaAxes,
} from '../../../../_lib/personaTypes';

/**
 * Phase 3 / OB-67 Slice 5 — view-only persona radar.
 *
 * Custom SVG (~80 LOC, no `recharts` per persona-ui-v1.md §13.1). 12-axis
 * polygon — `Math.cos(2π * i / 12)` / `Math.sin(2π * i / 12)`. Unset axes
 * fall back to PERSONA_AXIS_NEUTRAL (50) so the polygon is always
 * closed. Click on an axis label fires `onAxisFocus(axis)` so the parent
 * can scroll-into-view the corresponding `<DimensionSlider />` (Phase 3
 * onboarding ergonomics; Phase 4 will hang the family-default polygon
 * underneath).
 *
 * Brand: accent stroke + 18% accent fill on the persona polygon, dotted
 * `--fg-subtle` for the neutral baseline ring. NO Magenta on state.
 *
 * Empty input ({} axes) renders the neutral baseline only — useful as a
 * "what's possible" preview for fresh drafts.
 */

export interface PersonaRadarProps {
  axes?: PersonaAxes;
  /** Optional handler — when provided, axis labels render as clickable
   *  buttons; on click the parent typically scrolls the matching slider
   *  into view. */
  onAxisFocus?: (axis: keyof PersonaAxes) => void;
  /** Width / height in CSS pixels. Stays square. */
  size?: number;
  /** Optional className passthrough — the parent commonly wants to
   *  align/centre the radar inside its pillar grid. */
  className?: string;
}

const DEFAULT_SIZE = 240;
const PADDING = 38;
const RING_FRACTIONS = [0.25, 0.5, 0.75, 1];

export function PersonaRadar({
  axes,
  onAxisFocus,
  size = DEFAULT_SIZE,
  className,
}: PersonaRadarProps): React.ReactElement {
  const id = useId();
  const titleId = `${id}-title`;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - PADDING;
  const n = ALL_PERSONA_AXES.length;

  // Axis vertices: start at top (12 o'clock), step clockwise — natural
  // reading order.
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;

  const points = ALL_PERSONA_AXES.map((axis, i) => {
    const value = axes?.[axis] ?? PERSONA_AXIS_NEUTRAL;
    const ratio = value / 100;
    const a = angle(i);
    return {
      axis,
      x: cx + Math.cos(a) * r * ratio,
      y: cy + Math.sin(a) * r * ratio,
      labelX: cx + Math.cos(a) * (r + 18),
      labelY: cy + Math.sin(a) * (r + 18),
    };
  });

  const polygonPoints = points.map((p) => `${p.x},${p.y}`).join(' ');
  const neutralPolygonPoints = ALL_PERSONA_AXES.map((_axis, i) => {
    const a = angle(i);
    const ratio = PERSONA_AXIS_NEUTRAL / 100;
    return `${cx + Math.cos(a) * r * ratio},${cy + Math.sin(a) * r * ratio}`;
  }).join(' ');

  return (
    <div
      className={cn('flex flex-col items-center gap-2', className)}
      data-testid="persona-radar"
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>Persona Radar</title>

        {/* Concentric grid rings */}
        {RING_FRACTIONS.map((f, i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r * f}
            fill="none"
            stroke="var(--border)"
            strokeOpacity={0.4}
            strokeWidth={1}
          />
        ))}

        {/* Axis spokes */}
        {ALL_PERSONA_AXES.map((axis, i) => {
          const a = angle(i);
          return (
            <line
              key={axis}
              x1={cx}
              y1={cy}
              x2={cx + Math.cos(a) * r}
              y2={cy + Math.sin(a) * r}
              stroke="var(--border)"
              strokeOpacity={0.35}
              strokeWidth={1}
            />
          );
        })}

        {/* Neutral baseline polygon (50 across all axes, dotted) */}
        <polygon
          points={neutralPolygonPoints}
          fill="none"
          stroke="var(--fg-subtle)"
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.6}
        />

        {/* Persona polygon (filled) */}
        <polygon
          points={polygonPoints}
          fill="var(--accent)"
          fillOpacity={0.18}
          stroke="var(--accent)"
          strokeWidth={2}
        />

        {/* Vertex dots on the persona polygon */}
        {points.map((p) => (
          <circle
            key={p.axis}
            cx={p.x}
            cy={p.y}
            r={2.5}
            fill="var(--accent)"
          />
        ))}

        {/* Axis labels (clickable when onAxisFocus provided) */}
        {points.map((p) => {
          const label = p.axis;
          const text = (
            <text
              x={p.labelX}
              y={p.labelY}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={9}
              fill="var(--fg-muted)"
              style={{
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                fontFamily: 'var(--font-display, sans-serif)',
              }}
            >
              {label}
            </text>
          );
          if (!onAxisFocus) return <g key={p.axis}>{text}</g>;
          return (
            <g
              key={p.axis}
              role="button"
              tabIndex={0}
              onClick={() => onAxisFocus(p.axis as keyof PersonaAxes)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onAxisFocus(p.axis as keyof PersonaAxes);
                }
              }}
              style={{ cursor: 'pointer' }}
              data-testid={`persona-radar-label-${p.axis}`}
            >
              {text}
            </g>
          );
        })}
      </svg>
      <p className="font-mono-num text-[10px] text-[color:var(--fg-subtle)]">
        Persona vs.{' '}
        <span className="opacity-70">Neutral (50)</span>
      </p>
    </div>
  );
}

/**
 * Lookup helper used by the parent to map an axis label click to the
 * corresponding `<DimensionSlider />` `data-testid` so a smooth-scroll
 * works without prop-drilling refs.
 */
export function personaAxisToSliderTestId(axis: string): string {
  return `dimension-slider-${axis}`;
}

export const PERSONA_AXIS_DESCRIPTIONS = PERSONA_AXIS_LABELS;
