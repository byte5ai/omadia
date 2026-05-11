'use client';

import { useState } from 'react';
import { AlertOctagon, AlertTriangle, X } from 'lucide-react';

import { cn } from '../../../../_lib/cn';
import type { PersonaConflictWarning } from '../../../../_lib/personaConflicts';

/**
 * Phase 3 / OB-67 Slice 4 — persona × quality conflict banner.
 *
 * Renders above the persona pillar. Hard conflicts are dismissible but
 * persistent (re-appear on every render until the underlying values
 * stop conflicting); soft conflicts get a compact list. Empty input =
 * banner unmounts entirely.
 *
 * Brand: --danger token for hard, --warning token for soft. NO Magenta
 * on state (b5-colon reservation per persona-ui-v1.md §13.2).
 */

export interface ConflictBannerProps {
  warnings: readonly PersonaConflictWarning[];
}

export function ConflictBanner({
  warnings,
}: ConflictBannerProps): React.ReactElement | null {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  if (warnings.length === 0) return null;

  const visible = warnings.filter((w) => !dismissed.has(w.id));
  if (visible.length === 0) return null;

  const hardWarnings = visible.filter((w) => w.severity === 'hard');
  const softWarnings = visible.filter((w) => w.severity === 'soft');

  return (
    <div className="space-y-2" data-testid="persona-conflict-banner">
      {hardWarnings.map((w) => (
        <div
          key={w.id}
          role="alert"
          className={cn(
            'flex items-start gap-3 rounded-md p-3 text-sm',
            'border border-[color:var(--danger)]/40',
            'bg-[color:var(--danger)]/8 text-[color:var(--fg-strong)]',
          )}
          data-testid={`conflict-hard-${w.id}`}
        >
          <AlertOctagon
            className="size-4 shrink-0 text-[color:var(--danger)]"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-[color:var(--danger)]">
              Konflikt
            </p>
            <p className="mt-0.5 text-[color:var(--fg)]">{w.message}</p>
            <p className="mt-1 font-mono-num text-[10px] text-[color:var(--fg-subtle)]">
              {w.axes.join(' × ')}
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              setDismissed((prev) => {
                const next = new Set(prev);
                next.add(w.id);
                return next;
              })
            }
            className="text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
            aria-label="Konflikt-Hinweis ausblenden"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ))}
      {softWarnings.length > 0 ? (
        <ul
          className={cn(
            'space-y-1 rounded-md border border-[color:var(--warning)]/40',
            'bg-[color:var(--warning)]/6 p-2 text-xs text-[color:var(--fg)]',
          )}
        >
          {softWarnings.map((w) => (
            <li
              key={w.id}
              className="flex items-start gap-2"
              data-testid={`conflict-soft-${w.id}`}
            >
              <AlertTriangle
                className="size-3.5 shrink-0 text-[color:var(--warning)]"
                aria-hidden
              />
              <span>{w.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
