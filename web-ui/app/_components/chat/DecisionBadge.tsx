'use client';

import { useTranslations } from 'next-intl';

import { decisionBadgeView } from '../../_lib/decisionBadge';

const STATE_CLASS = {
  answered: 'bg-[color:var(--success)]/10 text-[color:var(--success)] ring-[color:var(--success)]',
  data: 'bg-[color:var(--info)]/10 text-[color:var(--info)] ring-[color:var(--info)]',
  model: 'bg-[color:var(--accent)]/10 text-[color:var(--accent)] ring-[color:var(--accent)]',
} as const;

/**
 * Inline chip at the top of an assistant turn: a decision model (TypeSafe
 * Jev, …) decided this turn before any language-model call — answered from
 * data without the agent, routed to a data source, or handed to the model.
 * The tooltip carries confidence, time and the source.
 */
export function DecisionBadge({ decision }: { decision: unknown }): React.ReactElement | null {
  const t = useTranslations('chat.decision');
  const view = decisionBadgeView(decision);
  if (!view) return null;
  const route = view.route !== undefined ? t(`route.${view.route}`) : '';
  return (
    <div
      className="group relative mb-2 inline-flex flex-wrap items-center gap-2 text-[11px] text-[color:var(--fg-muted)]"
      tabIndex={view.steps !== undefined ? 0 : undefined}
      title={t('tooltip', {
        provider: view.model !== undefined ? `${view.provider} (${view.model})` : view.provider,
        confidence: view.confidencePct,
        ms: view.ms,
        tool: view.tool ?? '—',
      })}
      data-decision-state={view.state}
    >
      <span className="font-medium uppercase tracking-[0.12em]">{view.provider}</span>
      <span className="text-[color:var(--fg-subtle)]">→</span>
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium uppercase tracking-[0.08em] ring-1 ${STATE_CLASS[view.state]}`}
      >
        {t(`state.${view.state}`)}
      </span>
      {view.state === 'model' && route !== '' && <span className="rounded bg-current/10 px-2 py-0.5 font-medium">{route}</span>}
      {view.state !== 'model' && view.tool !== undefined && (
        <span className="rounded bg-current/10 px-2 py-0.5 font-mono">{view.tool}</span>
      )}
      {view.direct && <span className="text-[color:var(--fg-subtle)]">{t('direct')}</span>}
      <span className="text-[color:var(--fg-subtle)]">
        {t('stats', { confidence: view.confidencePct, ms: view.ms })}
      </span>
      {view.steps !== undefined && (
        <div
          role="tooltip"
          className="pointer-events-none invisible absolute left-0 top-full z-20 mt-1 min-w-[300px] rounded-md bg-[color:var(--bg-elevated,var(--bg))] p-3 opacity-0 shadow-lg ring-1 ring-[color:var(--border)] transition-opacity group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100"
        >
          <div className="mb-2 font-medium text-[color:var(--fg)]">{t('stepsTitle', { provider: view.provider })}</div>
          <ul className="grid gap-1">
            {view.steps.map((step, i) => (
              <li key={`${step.task}-${i}`} className="grid grid-cols-[100px_1fr_auto] items-baseline gap-2">
                <span className="text-[color:var(--fg-subtle)]">{t(`task.${step.task}`)}</span>
                <span className="font-mono">{step.choiceKey !== undefined ? t(`choice.${step.choiceKey}`) : step.choice}</span>
                <span className="whitespace-nowrap text-[color:var(--fg-subtle)]">
                  {t('stats', { confidence: step.confidencePct, ms: step.ms })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
