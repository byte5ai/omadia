'use client';

import { useTranslations } from 'next-intl';

import type { RecalledContextSnapshot } from '../../_lib/chatSessions';

/**
 * Cross-session recall probe — inline card showing what the per-turn KG
 * probe pulled from PRIOR sessions (open plans, stored processes, curated
 * insights), rendered straight from the turn stream.
 *
 * The orchestrator emits a `turn_annotation` (channel `kg_recall`) carrying a
 * {@link RecalledContextSnapshot} before the answer tokens. The chat store
 * folds it onto `message.recalledContext`, so this is a pure render — no
 * fetch, no poll. Collapsed by default (it's supporting context, not the
 * answer). Returns null when every section is empty.
 */

interface Props {
  recalled: RecalledContextSnapshot;
}

export function RecalledContextCard({
  recalled,
}: Props): React.ReactElement | null {
  const t = useTranslations('recalledContext');

  const { plans, processes, insights } = recalled;
  if (plans.length === 0 && processes.length === 0 && insights.length === 0) {
    return null;
  }

  return (
    <details className="mb-2 rounded-md border border-sky-200 bg-sky-50/50 text-xs dark:border-sky-900/50 dark:bg-sky-950/20">
      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 font-medium text-sky-700 dark:text-sky-300">
        <span aria-hidden>🧠</span>
        <span>{t('heading')}</span>
        <span className="font-normal text-sky-500 dark:text-sky-400">
          {t('summary', {
            plans: plans.length,
            processes: processes.length,
            insights: insights.length,
          })}
        </span>
      </summary>
      <div className="flex flex-col gap-2 px-2.5 pb-2 pt-0.5">
        {plans.length > 0 && (
          <section>
            <h4 className="text-[10px] uppercase tracking-wide text-sky-600 dark:text-sky-400">
              {t('plansHeading')}
            </h4>
            <ul className="flex flex-col gap-0.5">
              {plans.map((p) => (
                <li
                  key={p.planId}
                  className="text-neutral-700 dark:text-neutral-300"
                >
                  {p.strategy ? `${p.strategy} — ` : ''}
                  <span className="text-neutral-400 dark:text-neutral-500">
                    {t('stepsProgress', {
                      done: p.doneCount,
                      total: p.totalCount,
                    })}
                  </span>
                  {p.openStepGoals.length > 0 && (
                    <span>
                      {' · '}
                      {t('openLabel')}: {p.openStepGoals.join('; ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {processes.length > 0 && (
          <section>
            <h4 className="text-[10px] uppercase tracking-wide text-sky-600 dark:text-sky-400">
              {t('processesHeading')}
            </h4>
            <ul className="flex flex-col gap-0.5">
              {processes.map((pr) => (
                <li
                  key={pr.id}
                  className="text-neutral-700 dark:text-neutral-300"
                >
                  {pr.title}{' '}
                  <span className="text-neutral-400 dark:text-neutral-500">
                    ({t('stepCount', { count: pr.stepCount })})
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {insights.length > 0 && (
          <section>
            <h4 className="text-[10px] uppercase tracking-wide text-sky-600 dark:text-sky-400">
              {t('insightsHeading')}
            </h4>
            <ul className="flex flex-col gap-0.5">
              {insights.map((ins) => (
                <li
                  key={ins.mkId}
                  className="text-neutral-700 dark:text-neutral-300"
                >
                  <span className="text-neutral-400 dark:text-neutral-500">
                    {ins.kind}:
                  </span>{' '}
                  {ins.summary}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  );
}
