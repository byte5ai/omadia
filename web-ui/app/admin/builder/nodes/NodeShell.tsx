'use client';

import { Handle, Position } from '@xyflow/react';
import type { CanvasNodeKind } from '../../../_lib/agentBuilder';

export interface NodeShellProps {
  kind: CanvasNodeKind;
  title: string;
  subtitle?: string | null;
  badge?: string | null;
  selected?: boolean;
  /** Render a target handle (left) — node can be a connection target. */
  hasTarget?: boolean;
  /** Render a source handle (right) — node can start a connection. */
  hasSource?: boolean;
  children?: React.ReactNode;
}

const ACCENTS: Record<CanvasNodeKind, string> = {
  channel: 'var(--accent)',
  agent: '#7c5cff',
  subagent: '#3aa0ff',
  skill: '#34d399',
  tool: '#f59e0b',
  mcp: '#ec4899',
  schedule: '#a3a3a3',
};

/**
 * Shared visual shell for every canvas node. Keeps each node-type file tiny
 * — they just pass a title/subtitle/badge and which handles to expose. The
 * left/coloured rail encodes the node kind at a glance.
 */
export function NodeShell({
  kind,
  title,
  subtitle,
  badge,
  selected,
  hasTarget,
  hasSource,
  children,
}: NodeShellProps): React.ReactElement {
  const accent = ACCENTS[kind];
  return (
    <div
      className="relative min-w-[180px] max-w-[260px] overflow-hidden rounded-lg border bg-[color:var(--card)] text-left shadow-sm"
      style={{
        borderColor: selected ? accent : 'var(--border)',
        boxShadow: selected ? `0 0 0 1px ${accent}` : undefined,
      }}
    >
      <div className="absolute inset-y-0 left-0 w-1" style={{ background: accent }} />
      {hasTarget && (
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: accent, width: 9, height: 9 }}
        />
      )}
      {hasSource && (
        <Handle
          type="source"
          position={Position.Right}
          style={{ background: accent, width: 9, height: 9 }}
        />
      )}
      <div className="px-3 py-3 pl-4">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[13px] font-semibold leading-tight text-[color:var(--fg-strong)]">
            {title}
          </span>
          {badge ? (
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[9px] uppercase tracking-[0.14em]"
              style={{ background: `${accent}22`, color: accent }}
            >
              {badge}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[color:var(--fg-muted)]">
            {subtitle}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}
