'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ApiError } from '../../../_lib/api';
import {
  listDeletedAgents,
  purgeDeletedAgent,
  type DeletedAgentDto,
  type EndOfServiceDto,
} from '../../../_lib/agents';
import { useConfirmAction } from './useConfirmAction';

/**
 * #2088 — what ended with an agent that was just disabled or deleted.
 *
 * Disabling or deleting an agent takes it out of service: the processes of
 * its archetype are ended by the archetype plugin, and omadia stops
 * delivering messages for it. The operator sees which conversations that
 * concerned, instead of a silent status flip.
 */
export interface EndOfServiceResult {
  readonly agentName: string;
  readonly change: 'disabled' | 'deleted';
  readonly report: EndOfServiceDto;
}

export function EndOfServiceNotice({
  result,
  onDismiss,
}: {
  result: EndOfServiceResult;
  onDismiss: () => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents.endOfService');
  const { report } = result;
  const noticesOwed = t('noticesOwed', { count: report.system_notices_owed });
  return (
    <div
      role="status"
      data-testid="end-of-service-notice"
      className="space-y-2 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-3 text-sm"
    >
      <p className="font-medium">{t(result.change, { name: result.agentName })}</p>
      {report.process_outcome === 'failed' ? (
        <p className="text-[color:var(--danger)]">{t('pluginFailed', { detail: report.process_detail ?? '' })}</p>
      ) : (
        <p>{t('processes', { count: report.processes.length })}</p>
      )}
      {report.processes.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5">
          {report.processes.map((process) => (
            <li key={process.process_id}>
              {t(
                process.outcome === 'failed'
                  ? 'outcomeFailed'
                  : process.report_posted === true
                    ? 'outcomeAbortedReported'
                    : 'outcomeAborted',
                { channel: process.channel_type, conversation: process.conversation_id },
              )}
              {process.detail ? <span className="text-[color:var(--fg-muted)]"> — {process.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p>{t('subscriptions', { count: report.subscriptions_ended.length })}</p>
      {noticesOwed.length > 0 ? <p className="text-[color:var(--fg-muted)]">{noticesOwed}</p> : null}
      <Button variant="secondary" size="sm" onClick={onDismiss}>
        {t('dismiss')}
      </Button>
    </div>
  );
}

/**
 * #2088 — deleted agents. A delete keeps the agent's record (a conversation
 * bound to it must not be taken over by another agent); removing it for good
 * is this separate, explicit step. Inside the retention period the operator
 * types the slug.
 */
export function DeletedAgentsSection({ refreshKey }: { refreshKey: number }): React.ReactElement | null {
  const t = useTranslations('operatorAgents.deletedAgents');
  const confirmAction = useConfirmAction();
  const format = useFormatter();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'loaded'; retentionDays: number; agents: DeletedAgentDto[] }
  >({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback((): void => {
    listDeletedAgents()
      .then((res) => setState({ kind: 'loaded', retentionDays: res.retention_days, agents: res.agents }))
      // A middleware without the endpoint (it predates tombstones) has no
      // deleted agents to show: the section stays away.
      .catch((err: unknown) =>
        setState(err instanceof ApiError && err.status === 404 ? { kind: 'loaded', retentionDays: 0, agents: [] } : { kind: 'error' }),
      );
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (state.kind === 'loading') return null;
  if (state.kind === 'loaded' && state.agents.length === 0) return null;

  function run(agent: DeletedAgentDto, confirmation?: string): void {
    setMessage(null);
    setBusy(agent.id);
    purgeDeletedAgent(agent.id, confirmation)
      .catch(() => setMessage(t('loadFailed')))
      .finally(() => {
        setBusy(null);
        load();
      });
  }

  /** Before the retention period is over the operator types the slug; after
   *  it a plain confirmation is enough. Both in the app's own dialog. */
  function purge(agent: DeletedAgentDto, retentionDays: number): void {
    confirmAction.ask({
      title: t('purgeConfirm', { slug: agent.slug }),
      confirmLabel: t('purge'),
      ...(agent.purgeable_without_confirmation
        ? { onConfirm: () => run(agent) }
        : {
            typed: { expected: agent.slug, prompt: t('purgeTypeSlug', { days: retentionDays, slug: agent.slug }) },
            onConfirm: () => run(agent, agent.slug),
          }),
    });
  }

  return (
    <section className="space-y-3" data-testid="deleted-agents-section">
      {confirmAction.dialog}
      <div>
        <h2 className="text-lg font-medium">{t('heading')}</h2>
        <p className="mt-1 max-w-3xl text-xs text-[color:var(--fg-muted)]">{t('intro')}</p>
      </div>
      {message ? <p className="text-sm text-[color:var(--danger)]">{message}</p> : null}
      {state.kind === 'error' ? (
        <p className="text-sm text-[color:var(--danger)]">{t('loadFailed')}</p>
      ) : (
        <ul className="space-y-2">
          {state.agents.map((agent) => {
            const when = format.dateTime(new Date(agent.deleted_at), { dateStyle: 'medium', timeStyle: 'short' });
            return (
              <li
                key={agent.id}
                data-testid={`deleted-agent-${agent.slug}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-2 text-sm"
              >
                <span>
                  {agent.deleted_by
                    ? t('rowBy', { name: agent.name, slug: agent.slug, when, by: agent.deleted_by })
                    : t('row', { name: agent.name, slug: agent.slug, when })}
                  {!agent.purgeable_without_confirmation ? (
                    <span className="block text-xs text-[color:var(--fg-muted)]">
                      {t('purgeableFrom', {
                        when: format.dateTime(new Date(agent.purgeable_from), { dateStyle: 'medium' }),
                      })}
                    </span>
                  ) : null}
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => purge(agent, state.retentionDays)}
                >
                  {busy === agent.id ? t('purging') : t('purge')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
