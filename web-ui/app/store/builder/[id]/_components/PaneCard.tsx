'use client';

import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';

import { cn } from '../../../../_lib/cn';

interface PaneCardProps {
  /** Section number shown in the header eyebrow. */
  index: string;
  /** Header title (display font). */
  title: string;
  /** Right-side metadata or controls (chips, model selector, etc.). */
  meta?: ReactNode;
  /** Pane body. Caller controls inner padding/scroll. */
  children: ReactNode;
  /** When `true`, the pane stretches to fill remaining flex height. */
  fill?: boolean;
  /** Collapsed mode: pane shrinks to a thin rail with the title rotated
   *  90° vertical, body hidden. Click anywhere on the rail to expand. */
  collapsed: boolean;
  /** Toggle the collapsed state. The Workspace owns the actual flag so it
   *  can adjust sibling layout when one pane opens or closes. */
  onToggleCollapsed: () => void;
  /** Number of "missing required" items the user needs to fix in this
   *  pane. Renders a warning chip in the open header AND a small dot on
   *  the collapsed rail so the user spots unfinished business at a
   *  glance, regardless of which pane is currently open. */
  warningCount?: number;
  /** Optional "fullscreen this pane" callback. When provided, the open
   *  header shows a maximize/restore button next to the collapse button.
   *  The Workspace passes a callback that collapses every sibling pane
   *  so the active pane spans the full row. */
  onMaximize?: () => void;
  /** True when this pane is the only one expanded — used to flip the
   *  maximize button into a "restore" state so the user can recover the
   *  multi-pane layout with a single click. */
  isMaximized?: boolean;
  className?: string;
}

const COLLAPSE_TRANSITION = {
  type: 'spring' as const,
  stiffness: 220,
  damping: 28,
  mass: 0.7,
};

/**
 * Visual chrome around each Workspace pane.
 *
 * Two modes:
 *   - **expanded**: classic eyebrow-index + display title + optional
 *     right-aligned meta row + collapse button + divider + body.
 *   - **collapsed**: thin vertical rail, the index + title rotated 90°
 *     via `writing-mode: vertical-rl`. The whole rail is the click target
 *     to expand again. The body is unmounted so collapsed panes don't
 *     keep heavy children (Monaco editor, NDJSON consumers) live.
 *
 * Width transitions are animated by framer-motion's `layout` prop on the
 * outer section; siblings re-flow smoothly when one pane opens or closes.
 * The body fades in/out via `AnimatePresence` so the content doesn't pop.
 */
export function PaneCard({
  index,
  title,
  meta,
  children,
  fill = false,
  collapsed,
  onToggleCollapsed,
  warningCount = 0,
  onMaximize,
  isMaximized = false,
  className,
}: PaneCardProps): React.ReactElement {
  const hasWarning = warningCount > 0;
  return (
    <motion.section
      layout
      transition={COLLAPSE_TRANSITION}
      className={cn(
        'flex flex-col rounded-[14px] border bg-[color:var(--bg-elevated)]',
        'overflow-hidden',
        hasWarning
          ? 'border-[color:var(--danger)]/50'
          : 'border-[color:var(--divider)]',
        collapsed
          ? 'w-12 shrink-0 cursor-pointer hover:bg-[color:var(--bg-soft)]'
          : 'min-w-[320px] flex-1',
        fill && 'h-full min-h-0',
        className,
      )}
      onClick={collapsed ? onToggleCollapsed : undefined}
      role={collapsed ? 'button' : undefined}
      aria-expanded={!collapsed}
      tabIndex={collapsed ? 0 : -1}
      onKeyDown={
        collapsed
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggleCollapsed();
              }
            }
          : undefined
      }
    >
      <AnimatePresence initial={false} mode="wait">
        {collapsed ? (
          <motion.div
            key="rail"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex h-full flex-col items-center gap-3 py-4 text-[color:var(--fg-muted)]"
          >
            <PanelLeftOpen
              className="size-3.5 shrink-0 text-[color:var(--fg-subtle)]"
              aria-hidden
            />
            {hasWarning ? (
              <span
                className="font-mono-num inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-[color:var(--danger)] px-1 text-[10px] font-semibold text-white"
                aria-label={`${String(warningCount)} fehlt`}
                title={`${String(warningCount)} Pflicht-Felder fehlen`}
              >
                {warningCount}
              </span>
            ) : null}
            <div
              className="flex flex-1 items-center justify-center"
              style={{
                writingMode: 'vertical-rl',
                transform: 'rotate(180deg)',
              }}
            >
              <span className="flex items-baseline gap-3">
                <span className="font-mono-num text-[10px] font-semibold uppercase tracking-[0.24em] text-[color:var(--fg-subtle)]">
                  {index}
                </span>
                <span
                  className={cn(
                    'font-display text-[16px] leading-none',
                    hasWarning
                      ? 'text-[color:var(--danger)]'
                      : 'text-[color:var(--fg-strong)]',
                  )}
                >
                  {title}
                </span>
              </span>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="open"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <header className="flex items-baseline gap-3 border-b border-[color:var(--divider)] px-5 py-4">
              <span className="font-mono-num text-[10px] font-semibold uppercase tracking-[0.24em] text-[color:var(--fg-subtle)]">
                {index}
              </span>
              <h2 className="font-display truncate text-[18px] leading-none text-[color:var(--fg-strong)]">
                {title}
              </h2>
              {hasWarning ? (
                <span
                  className="font-mono-num inline-flex items-center gap-1 rounded-full bg-[color:var(--danger)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-white"
                  title={`${String(warningCount)} Pflicht-Felder fehlen`}
                >
                  <AlertTriangle className="size-2.5" aria-hidden />
                  {warningCount} fehlt
                </span>
              ) : null}
              <div className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-[color:var(--fg-muted)]">
                {meta}
                {onMaximize ? (
                  <button
                    type="button"
                    onClick={onMaximize}
                    aria-label={
                      isMaximized
                        ? `${title} aus Vollbild zurückholen`
                        : `${title} maximieren`
                    }
                    title={
                      isMaximized
                        ? 'Andere Panes wieder einblenden'
                        : 'Diese Pane maximieren'
                    }
                    className="rounded-md p-1 text-[color:var(--fg-subtle)] transition-colors hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]"
                  >
                    {isMaximized ? (
                      <Minimize2 className="size-3.5" aria-hidden />
                    ) : (
                      <Maximize2 className="size-3.5" aria-hidden />
                    )}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={onToggleCollapsed}
                  aria-label={`${title} einklappen`}
                  className="rounded-md p-1 text-[color:var(--fg-subtle)] transition-colors hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]"
                >
                  <PanelLeftClose className="size-3.5" aria-hidden />
                </button>
              </div>
            </header>
            <div className={cn('flex min-h-0 flex-1 flex-col', fill && 'min-h-0')}>
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}
