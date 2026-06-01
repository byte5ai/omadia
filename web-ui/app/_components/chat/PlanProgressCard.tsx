'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  type PlanOverlay,
  planStepColor,
} from '../../graph/_components/graphTypes';

/**
 * #133 (E8) — inline plan-DAG progress for a single chat turn, LIVE.
 *
 * The orchestrator drives the turn; the plan-runner plugin persists a parallel
 * Plan + PlanStep DAG and updates step status in real time as tools complete.
 *
 * Resolving "this turn's plan":
 *  - WHILE STREAMING the chat has no Turn id yet, but it has the scope. The
 *    current turn's plan is the newest plan in the scope that the plugin has
 *    NOT yet back-linked to a Turn — `props.turnId` is written only at
 *    `onAfterTurn`, so an unlinked plan is the one still in flight. We poll it
 *    so step status (pending → in_progress → done) and any replan adapt live.
 *  - AFTER the turn finishes the chat has `message.turnId` (the persisted Turn
 *    node id); we resolve precisely by `props.turnId === turnId` and stop.
 *
 * Renders nothing until a plan exists (most turns produce none — only the ones
 * the Haiku gate flags). Shown uncollapsed at the top of the assistant turn.
 */

type PlanEntry = PlanOverlay['plans'][number];

interface Props {
  /** Session scope (== chat tab id == orchestrator scope). */
  scope: string;
  /** Persisted Turn node id (`turn:<scope>:<time>`); absent while streaming. */
  turnId?: string;
  /** True while the turn is still streaming → poll + show the in-flight plan. */
  streaming: boolean;
}

async function fetchPlansForScope(scope: string): Promise<PlanEntry[]> {
  try {
    const res = await fetch(
      `/bot-api/dev/graph/plans?scope=${encodeURIComponent(scope)}`,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as PlanOverlay;
    return body.plans ?? [];
  } catch {
    return [];
  }
}

const POLL_MS = 1500;
// After the turn ends, the PLAN_OF back-link lands a beat later — retry a few
// times so the card transitions cleanly from the in-flight to the linked plan.
const POST_DONE_RETRIES = 4;

export function PlanProgressCard({
  scope,
  turnId,
  streaming,
}: Props): React.ReactElement | null {
  const t = useTranslations('planCard');
  const [entry, setEntry] = useState<PlanEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    const pick = (plans: PlanEntry[]): PlanEntry | null => {
      if (streaming) {
        // Newest-first; the first not-yet-linked plan is this turn's.
        return plans.find((p) => !p.plan.props['turnId']) ?? null;
      }
      if (turnId) {
        return (
          plans.find((p) => String(p.plan.props['turnId'] ?? '') === turnId) ??
          null
        );
      }
      return null;
    };

    const tick = async (): Promise<void> => {
      const plans = await fetchPlansForScope(scope);
      if (cancelled) return;
      const found = pick(plans);
      if (found) setEntry(found);
      if (streaming) {
        timer = setTimeout(() => void tick(), POLL_MS);
      } else if (!found && turnId && retries < POST_DONE_RETRIES) {
        retries += 1;
        timer = setTimeout(() => void tick(), POLL_MS);
      } else if (!found && turnId) {
        // Terminal: this finished turn has no plan of its own — make sure a
        // plan briefly shown during streaming (e.g. a leaked unlinked plan)
        // doesn't linger on a plan-less turn.
        setEntry(null);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [scope, turnId, streaming]);

  if (!entry) return null;

  const steps = [...entry.steps].sort(
    (a, b) => Number(a.props['order'] ?? 0) - Number(b.props['order'] ?? 0),
  );
  if (steps.length === 0) return null;
  const doneCount = steps.filter((s) => s.props['status'] === 'done').length;

  const statusLabel = (status: unknown): string => {
    switch (status) {
      case 'done':
        return t('statusDone');
      case 'in_progress':
        return t('statusInProgress');
      case 'failed':
        return t('statusFailed');
      case 'skipped':
        return t('statusSkipped');
      default:
        return t('statusPending');
    }
  };

  return (
    <details
      open
      className="mb-2 rounded-md border border-violet-200 bg-violet-50/50 text-xs dark:border-violet-900/50 dark:bg-violet-950/20"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 font-medium text-violet-700 dark:text-violet-300">
        <span aria-hidden>🗺</span>
        <span>{t('heading')}</span>
        <span className="font-normal text-violet-500 dark:text-violet-400">
          {t('summary', { done: doneCount, total: steps.length })}
        </span>
        {streaming && (
          <span
            className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500"
            title={t('statusInProgress')}
            aria-hidden
          />
        )}
      </summary>
      <ol className="flex flex-col gap-1 px-2.5 pb-2 pt-0.5">
        {steps.map((s, i) => {
          const status = s.props['status'];
          const goal = String(s.props['goal'] ?? '');
          const active = status === 'in_progress';
          return (
            <li key={s.id} className="flex items-start gap-2">
              <span
                className={`mt-[3px] h-2 w-2 flex-shrink-0 rounded-full${
                  active ? ' animate-pulse' : ''
                }`}
                style={{ backgroundColor: planStepColor(status) }}
                title={statusLabel(status)}
                aria-hidden
              />
              <span
                className={
                  status === 'skipped'
                    ? 'text-neutral-400 line-through dark:text-neutral-500'
                    : 'text-neutral-700 dark:text-neutral-300'
                }
              >
                <span className="text-neutral-400 dark:text-neutral-500">
                  {i + 1}.
                </span>{' '}
                {goal}
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {statusLabel(status)}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
