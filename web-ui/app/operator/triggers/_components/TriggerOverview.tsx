'use client';

import { useCallback, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  endTrigger,
  getTriggerOverview,
  pauseTrigger,
  resumeTrigger,
  type TriggerDto,
  type TriggerOverviewDto,
} from '../../../_lib/triggers';

interface TriggerOverviewProps {
  readonly initial: TriggerOverviewDto;
}

type Action = 'pause' | 'resume' | 'end';

/** The engine's step codes (`check:new_activity`, `deliver`, …) → catalog keys. */
const STEP_KEYS: Readonly<Record<string, string>> = {
  'check:new_activity': 'newActivity',
  'check:context_live': 'contextLive',
  'check:data': 'dataCheck',
  post: 'post',
  deliver: 'deliver',
  turn: 'turn',
  batch: 'batch',
};

const PAUSE_REASONS: ReadonlySet<string> = new Set([
  'breaker_failures',
  'breaker_ineffective',
  'budget',
  'owner',
  'operator',
]);

const ACTIONS: Record<Action, (id: string) => Promise<void>> = {
  pause: pauseTrigger,
  resume: resumeTrigger,
  end: endTrigger,
};

/**
 * #2082 — the operator's list of everything agents do unasked, with the
 * month's spend against the caps and the plugin background jobs. Every
 * control re-reads the list afterwards: the server state is the truth.
 */
export function TriggerOverview(props: TriggerOverviewProps): React.ReactElement {
  const t = useTranslations('operatorTriggers');
  const format = useFormatter();
  const [data, setData] = useState<TriggerOverviewDto>(props.initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const usd = (n: number): string => format.number(n, { style: 'currency', currency: 'USD' });
  const when = (iso: string | null | undefined): string =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : t('never');

  const run = useCallback(
    async (trigger: TriggerDto, action: Action): Promise<void> => {
      setBusy(trigger.id);
      try {
        await ACTIONS[action](trigger.id);
        setData(await getTriggerOverview());
        setError(null);
      } catch {
        setError(t('actionError'));
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  const stepLabel = (step: string): string => {
    const key = STEP_KEYS[step];
    return key ? t(`steps.${key}`) : t('steps.other');
  };
  const pauseLabel = (reason: string | undefined): string =>
    reason && PAUSE_REASONS.has(reason) ? t(`pauseReasons.${reason}`) : t('pauseReasons.other');

  const schedule = (x: TriggerDto): string => {
    if (x.event) return t('schedule.event', { event: x.event });
    if (x.cron) return t('schedule.cron', { cron: x.cron, timezone: x.timezone ?? 'UTC' });
    if (x.everySeconds) return t('schedule.every', { minutes: Math.round(x.everySeconds / 60) });
    if (x.at) return t('schedule.at', { at: when(x.at) });
    return '—';
  };

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="trigger-spend" className="rounded border border-[color:var(--border)] p-4 text-sm">
        <h2 id="trigger-spend" className="mb-2 text-lg font-medium">
          {t('spend.heading')}
        </h2>
        <p>
          {t('spend.instance', {
            spent: usd(data.instance.spentUsd),
            reserved: usd(data.instance.reservedUsd),
            cap: usd(data.caps.monthlyInstanceUsd),
          })}
        </p>
        {Object.keys(data.agents).length > 0 && (
          <ul className="my-2 flex flex-col gap-0.5">
            {Object.entries(data.agents).map(([agentId, spend]) => (
              <li key={agentId}>
                {t('spend.agent', {
                  agent: data.triggers.find((x) => x.agentId === agentId)?.agent ?? agentId,
                  spent: usd(spend.spentUsd),
                  cap: usd(data.caps.monthlyAgentUsd),
                })}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[color:var(--fg-muted)]">
          {t('spend.caps', {
            agent: usd(data.caps.monthlyAgentUsd),
            trigger: usd(data.caps.perTriggerUsd),
            firing: usd(data.caps.perFiringUsd),
          })}
        </p>
      </section>

      {error && (
        <div
          role="alert"
          className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {error}
        </div>
      )}

      <section aria-labelledby="trigger-list">
        <h2 id="trigger-list" className="mb-2 text-lg font-medium">
          {t('list.heading', { count: data.triggers.length })}
        </h2>
        {data.triggers.length === 0 ? (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('list.empty')}</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[color:var(--fg-muted)]">
              <tr>
                <th className="py-1 pr-3">{t('list.agent')}</th>
                <th className="py-1 pr-3">{t('list.purpose')}</th>
                <th className="py-1 pr-3">{t('list.when')}</th>
                <th className="py-1 pr-3">{t('list.until')}</th>
                <th className="py-1 pr-3">{t('list.cost')}</th>
                <th className="py-1 pr-3">{t('list.state')}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {data.triggers.map((x) => (
                <tr key={x.id} className="border-t border-[color:var(--border)]/60 align-top">
                  <td className="py-2 pr-3 font-medium">{x.agent}</td>
                  <td className="py-2 pr-3">
                    <div>{x.purpose}</div>
                    <div className="text-xs text-[color:var(--fg-muted)]">
                      {t(`origin.${x.origin}`)} · {x.actions.map(stepLabel).join(' → ')}
                    </div>
                    {x.lastError && (
                      <details className="text-xs text-[color:var(--danger)]">
                        <summary>{t('list.lastError')}</summary>
                        <span className="font-mono">{x.lastError}</span>
                      </details>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <div>{schedule(x)}</div>
                    <div className="text-xs text-[color:var(--fg-muted)]">
                      {t('list.runs', { runs: x.runs, max: x.maxRuns ?? 0 })} · {t('list.lastFired', { at: when(x.lastFiredAt) })}
                    </div>
                  </td>
                  <td className="py-2 pr-3">{when(x.until)}</td>
                  <td className="py-2 pr-3">{t('list.costOf', { spent: usd(x.spentUsd), budget: usd(x.budgetUsd) })}</td>
                  <td className="py-2 pr-3">
                    {x.state === 'paused'
                      ? t('state.paused', { reason: pauseLabel(x.pausedBecause) })
                      : t('state.active')}
                  </td>
                  <td className="py-2 whitespace-nowrap">
                    {x.state === 'active' ? (
                      <Button variant="secondary" disabled={busy === x.id} onClick={() => void run(x, 'pause')}>
                        {t('actions.pause')}
                      </Button>
                    ) : (
                      <Button variant="secondary" disabled={busy === x.id} onClick={() => void run(x, 'resume')}>
                        {t('actions.resume')}
                      </Button>
                    )}{' '}
                    <Button variant="secondary" disabled={busy === x.id} onClick={() => void run(x, 'end')}>
                      {t('actions.end')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="trigger-jobs" className="text-sm">
        <h2 id="trigger-jobs" className="mb-2 text-lg font-medium">
          {t('jobs.heading')}
        </h2>
        {data.batchJobs.length > 0 && (
          <ul className="mb-3 list-disc pl-5">
            {data.batchJobs.map((j) => (
              <li key={j.id}>{t('jobs.batch', { purpose: j.purpose, minutes: j.intervalMinutes })}</li>
            ))}
          </ul>
        )}
        {data.jobs.length === 0 ? (
          <p className="text-[color:var(--fg-muted)]">{t('jobs.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.jobs.map((j) => (
              <li key={`${j.agentId}/${j.name}`}>
                <span className="font-medium">{j.agentId}</span> · {j.name} ·{' '}
                {j.consecutiveFailures > 0
                  ? t('jobs.failing', { failures: j.consecutiveFailures, next: when(j.nextProbeAt) })
                  : t('jobs.ok', { at: when(j.lastRunAt) })}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
