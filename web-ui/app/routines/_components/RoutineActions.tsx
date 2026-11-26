'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  deleteRoutine,
  setRoutineStatus,
  triggerRoutineNow,
  type RoutineDto,
} from '../../_lib/api';
import { routineErrorText, type RoutineErrorText } from './routineErrors';

/** #1749 — how often the page re-reads a routine while its run is in flight. */
const RUNNING_POLL_MS = 5_000;

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
  const [error, setError] = useState<RoutineErrorText | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isPaused = routine.status === 'paused';
  const isRunning = routine.running === true;
  const fail = (err: unknown): void => {
    setError(routineErrorText(err, (k) => t(k), t('actionFailed')));
  };

  // #1749 — while a run is in flight the row is re-read until it ends, so
  // the run history, the status and the button follow without a reload.
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => router.refresh(), RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isRunning, router]);

  const handleToggle = (): void => {
    setError(null);
    setNotice(null);
    const next = isPaused ? 'active' : 'paused';
    startTransition(async () => {
      try {
        await setRoutineStatus(routine.id, next);
        router.refresh();
      } catch (err) {
        fail(err);
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
        // the proactive sender — a Teams card, or (#1071) for `web`
        // routines an assistant message in the chat the routine was
        // created in.
        await triggerRoutineNow(routine.id);
        setNotice(
          t(routine.channel === 'web' ? 'triggerNoticeWeb' : 'triggerNotice'),
        );
        // Auto-clear after the typical run window so the row doesn't
        // stay decorated for ever.
        setTimeout(() => {
          setNotice(null);
        }, 45000);
        router.refresh();
      } catch (err) {
        // #473 / #1071 / #1748 / #1744 — the known refusals (no agent or key,
        // paused, a run in flight, the agent gone) name their fix; anything
        // else shows the server's reason under a localized headline.
        fail(err);
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
        fail(err);
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
          disabled={pending || isRunning}
          title={t('triggerTitle')}
          className="text-[11px] font-semibold"
        >
          {isRunning ? t('running') : t('triggerButton')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          pill
          onClick={handleToggle}
          disabled={pending}
        >
          {isPaused ? t('resume') : t('pause')}
        </Button>
        <Button
          variant="danger"
          size="sm"
          pill
          onClick={handleDelete}
          disabled={pending}
          className="text-[11px] font-semibold"
        >
          {t('delete')}
        </Button>
      </div>
      {error ? (
        <div className="max-w-xs text-right text-[11px] text-[color:var(--danger)]">
          <div>{error.headline}</div>
          {error.detail ? <div className="mt-0.5 font-mono text-[10px]">{error.detail}</div> : null}
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
