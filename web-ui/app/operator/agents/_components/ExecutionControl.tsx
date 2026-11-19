'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ApiError } from '../../../_lib/api';
import {
  clearKillSwitch,
  getExecutionOverview,
  setKillSwitch,
  releaseReservation,
  stopDiscussion,
  type ExecutionOverviewDto,
  type ExecutionScopeDto,
  type KillSwitchDto,
} from '../../../_lib/agents';
import { HeldReservations } from './HeldReservations';
import { RunningDiscussions } from './RunningDiscussions';

const KIND_KEY = {
  configuring: 'kindConfiguring',
  active: 'kindActive',
  closing: 'kindClosing',
  scheduling: 'kindScheduling',
  follow_up: 'kindFollowUp',
} as const;

const EMPTY: ExecutionOverviewDto = { kill_switches: [], scopes: [], discussions: [], discussions_failed: false };

/**
 * #2090 — what archetype plugins are currently allowed to do, and the
 * operator's stop.
 *
 * An archetype plugin (a facilitation engine) acts on its own schedule. Each
 * running process holds permissions with a deadline and a budget. Stopping
 * refuses every further action in reach (the instance, one agent, one
 * process) until the operator resumes; it ends and deletes nothing.
 *
 * Agent discussions (#2067) are listed below with their own, final stop: they
 * hold no such permissions, so the stops above do not reach them.
 *
 * The section stays away while nothing runs and nothing is stopped.
 */
export function ExecutionControlSection({ refreshKey }: { refreshKey: number }): React.ReactElement | null {
  const t = useTranslations('operatorAgents.execution');
  const format = useFormatter();
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error' } | { kind: 'loaded'; data: ExecutionOverviewDto }>({
    kind: 'loading',
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback((): void => {
    getExecutionOverview()
      .then((data) => setState({ kind: 'loaded', data }))
      // A middleware without the endpoint, or without a database, has nothing
      // to show or stop here.
      .catch((err: unknown) =>
        setState(
          err instanceof ApiError && (err.status === 404 || err.status === 503)
            ? { kind: 'loaded', data: EMPTY }
            : { kind: 'error' },
        ),
      );
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (state.kind === 'loading') return null;
  if (state.kind === 'loaded') {
    const { scopes, kill_switches: switches, discussions, discussions_failed: discussionsFailed } = state.data;
    const reservations = state.data.reservations ?? [];
    if (scopes.length === 0 && switches.length === 0 && discussions.length === 0 && !discussionsFailed && reservations.length === 0) {
      return null;
    }
  }

  function act(work: () => Promise<unknown>): void {
    setFailed(false);
    setBusy(true);
    work()
      .catch(() => setFailed(true))
      .finally(() => {
        setBusy(false);
        load();
      });
  }

  const when = (iso: string): string => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  function switchText(k: KillSwitchDto): string {
    const values = { by: k.set_by, when: when(k.set_at), agent: k.agent_slug ?? '', process: k.process_id ?? '' };
    if (k.level === 'instance') return t('switchInstance', values);
    return k.level === 'agent' ? t('switchAgent', values) : t('switchProcess', values);
  }

  function scopeRow(scope: ExecutionScopeDto): React.ReactElement {
    return (
      <li
        key={scope.id}
        data-testid={`execution-scope-${scope.id}`}
        className="flex flex-wrap items-center justify-between gap-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-2 text-sm"
      >
        <span>
          {t('scopeRow', { agent: scope.agent_slug, kind: t(KIND_KEY[scope.kind]), process: scope.process_id })}
          {scope.stopped ? (
            <span className="ml-2 rounded bg-[color:var(--danger)] px-1.5 py-0.5 text-xs text-white">{t('stopped')}</span>
          ) : null}
          <span className="block text-xs text-[color:var(--fg-muted)]">
            {t(scope.deadline_wait ? 'untilWaiting' : 'until', { when: when(scope.deadline) })}
            {' · '}
            {t('used', {
              actions: scope.used.actions,
              actionBudget: scope.budget.actions,
              calls: scope.used.model_calls,
              callBudget: scope.budget.model_calls,
            })}
          </span>
        </span>
        {scope.stopped ? null : (
          <span className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                act(() => setKillSwitch({ level: 'process', agent_slug: scope.agent_slug, process_id: scope.process_id }))
              }
            >
              {t('stopProcess')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => act(() => setKillSwitch({ level: 'agent', agent_slug: scope.agent_slug }))}
            >
              {t('stopAgent')}
            </Button>
          </span>
        )}
      </li>
    );
  }

  const data = state.kind === 'loaded' ? state.data : undefined;
  const instanceStopped = data?.kill_switches.some((k) => k.level === 'instance') ?? false;

  return (
    <section className="space-y-3" data-testid="execution-control-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">{t('heading')}</h2>
          <p className="mt-1 max-w-3xl text-xs text-[color:var(--fg-muted)]">{t('intro')}</p>
        </div>
        {data && !instanceStopped ? (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => act(() => setKillSwitch({ level: 'instance' }))}>
            {t('stopAll')}
          </Button>
        ) : null}
      </div>
      {failed ? <p className="text-sm text-[color:var(--danger)]">{t('actionFailed')}</p> : null}
      {!data ? (
        <p className="text-sm text-[color:var(--danger)]">{t('loadFailed')}</p>
      ) : (
        <>
          {data.kill_switches.length > 0 ? (
            <ul className="space-y-2" data-testid="execution-kill-switches">
              {data.kill_switches.map((k) => (
                <li
                  key={k.id}
                  data-testid={`kill-switch-${k.level}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded border border-[color:var(--danger)] px-4 py-2 text-sm"
                >
                  <span>
                    {switchText(k)}
                    {k.reason ? <span className="block text-xs text-[color:var(--fg-muted)]">{k.reason}</span> : null}
                  </span>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => clearKillSwitch(k.id))}>
                    {t('resume')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {data.scopes.length > 0 ? (
            <ul className="space-y-2">{data.scopes.map(scopeRow)}</ul>
          ) : (
            <p className="text-sm text-[color:var(--fg-muted)]">{t('nothingRunning')}</p>
          )}
          <RunningDiscussions
            discussions={data.discussions}
            loadFailed={data.discussions_failed}
            busy={busy}
            onStop={(workflowId) => act(() => stopDiscussion(workflowId))}
          />
          <HeldReservations
            reservations={data.reservations ?? []}
            busy={busy}
            onRelease={(id) => act(() => releaseReservation(id))}
          />
        </>
      )}
    </section>
  );
}
