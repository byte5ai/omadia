'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
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
  const t = useTranslations('routines.actions');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isPaused = routine.status === 'paused';

  const handleToggle = (): void => {
    setError(null);
    setNotice(null);
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
    setNotice(null);
    startTransition(async () => {
      try {
        // The backend returns 202 Accepted and runs the agent in the
        // background — the manual trigger takes ~30 s on a routine
        // with the HR-agent + retry. Surface a notice so the operator
        // knows the click was received; the actual result arrives via
        // the proactive sender (Teams card / web channel).
        await triggerRoutineNow(routine.id);
        setNotice(t('triggerNotice'));
        // Auto-clear after the typical run window so the row doesn't
        // stay decorated for ever.
        setTimeout(() => {
          setNotice(null);
        }, 45000);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const handleDelete = (): void => {
    if (!window.confirm(t('deleteConfirm', { name: routine.name }))) {
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
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="primary"
          size="sm"
          pill
          onClick={handleTriggerNow}
          disabled={pending}
          title={t('triggerTitle')}
          className="text-[11px] font-semibold"
        >
          {t('triggerButton')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          pill
          onClick={handleToggle}
          disabled={pending}
        >
          {isPaused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant="danger"
          size="sm"
          pill
          onClick={handleDelete}
          disabled={pending}
          className="text-[11px] font-semibold"
        >
          Delete
        </Button>
      </div>
      {error ? (
        <div className="font-mono text-[10px] text-[color:var(--danger)]">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="font-mono text-[10px] text-[color:var(--accent)]">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
