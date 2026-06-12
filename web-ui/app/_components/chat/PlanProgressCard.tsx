'use client';

import { useTranslations } from 'next-intl';

import type { PlanSnapshot } from '../../_lib/chatSessions';
import { planStepColor } from '../../graph/_components/graphTypes';

/**
 * #133 (E9) — inline plan-DAG progress for a chat turn, rendered straight from
 * the turn stream.
 *
 * The plan-runner emits a `turn_annotation` (channel `plan`) carrying a
 * {@link PlanSnapshot}: the orchestrator yields it as the FIRST stream event
 * (before any answer tokens) and re-emits it on every step change + replan.
 * The chat store folds it onto `message.plan`, so this component is a pure
 * render of the latest snapshot — no fetch, no poll, no dev-endpoint, no auth
 * dependency. Shown uncollapsed at the top of the assistant turn.
 */

interface Props {
  plan: PlanSnapshot;
  /** True while the turn is still streaming → pulse the live affordance. */
  streaming: boolean;
}

export function PlanProgressCard({
  plan,
  streaming,
}: Props): React.ReactElement | null {
  const t = useTranslations('planCard');

  const steps = [...plan.steps].sort((a, b) => a.order - b.order);
  if (steps.length === 0) return null;
  const doneCount = steps.filter((s) => s.status === 'done').length;

  const statusLabel = (status: string): string => {
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
      className="mb-2 rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-xs"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 font-medium text-[color:var(--accent)]">
        <span aria-hidden>🗺</span>
        <span>{t('heading')}</span>
        <span className="font-normal text-[color:var(--accent)]">
          {t('summary', { done: doneCount, total: steps.length })}
        </span>
        {streaming && (
          <span
            className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--accent)]/100"
            title={t('statusInProgress')}
            aria-hidden
          />
        )}
        {plan.reusedProcessTitle && (
          <span
            className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--success)]"
            title={t('reusedFrom', { title: plan.reusedProcessTitle })}
          >
            <span aria-hidden>♻</span>
            {t('reusedBadge')}
          </span>
        )}
      </summary>
      <ol className="flex flex-col gap-1 px-2.5 pb-2 pt-0.5">
        {steps.map((s, i) => {
          const active = s.status === 'in_progress';
          return (
            <li key={s.stepExternalId} className="flex items-start gap-2">
              <span
                className={`mt-[3px] h-2 w-2 flex-shrink-0 rounded-full${
                  active ? ' animate-pulse' : ''
                }`}
                style={{ backgroundColor: planStepColor(s.status) }}
                title={statusLabel(s.status)}
                aria-hidden
              />
              <span
                className={
                  s.status === 'skipped'
                    ? 'text-[color:var(--fg-subtle)] line-through'
                    : 'text-[color:var(--fg)]'
                }
              >
                <span className="text-[color:var(--fg-subtle)]">
                  {i + 1}.
                </span>{' '}
                {s.goal}
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[color:var(--fg-subtle)]">
                  {statusLabel(s.status)}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
