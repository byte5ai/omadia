'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  deleteRoutine,
  setRoutineStatus,
  triggerRoutineNow,
  type RoutineDto,
} from '../../_lib/api';

interface Props {
  routine: RoutineDto;
}

/**
 * Inline action buttons for one routine row. Mutations use the same /bot-api
 * proxy as the rest of the dashboard; on success we `router.refresh()` so
 * the server-rendered table picks up the new state without reloading the
 * tab. Errors surface inline (operator UI — no toast plumbing needed).
 */
export function RoutineActions({ routine }: Props): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isPaused = routine.status === 'paused';

  const handleToggle = (): void => {
    setError(null);
    const next = isPaused ? 'active' : 'paused';
    startTransition(async () => {
      try {
        await setRoutineStatus(routine.id, next);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const handleTriggerNow = (): void => {
    setError(null);
    startTransition(async () => {
      try {
        await triggerRoutineNow(routine.id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const handleDelete = (): void => {
    if (
      !window.confirm(
        `Delete routine '${routine.name}'? This cannot be undone.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await deleteRoutine(routine.id);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1.5">
        <button
          type="button"
          onClick={handleTriggerNow}
          disabled={pending}
          title="Routine jetzt manuell auslösen — feuert einen Agent-Run und liefert das Ergebnis ins Channel."
          className="rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--accent)] transition hover:border-[color:var(--accent)] disabled:opacity-50"
        >
          Jetzt
        </button>
        <button
          type="button"
          onClick={handleToggle}
          disabled={pending}
          className="rounded-full border border-[color:var(--border)] bg-[color:var(--surface)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--fg-muted)] transition hover:border-[color:var(--accent)] hover:text-[color:var(--fg-strong)] disabled:opacity-50"
        >
          {isPaused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={pending}
          className="rounded-full border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--danger)] transition hover:border-[color:var(--danger)] disabled:opacity-50"
        >
          Delete
        </button>
      </div>
      {error ? (
        <div className="font-mono text-[10px] text-[color:var(--danger)]">
          {error}
        </div>
      ) : null}
    </div>
  );
}
