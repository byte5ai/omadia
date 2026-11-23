'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import type { RunningDiscussionDto } from '../../../_lib/agents';

interface RunningDiscussionsProps {
  discussions: readonly RunningDiscussionDto[];
  /** The listing itself failed: say so instead of showing "none". */
  loadFailed: boolean;
  busy: boolean;
  onStop: (workflowId: string) => void;
}

/**
 * #2067 — agents discussing a topic with each other in a conversation.
 *
 * These are Conductor runs the agents started themselves. They hold no
 * execution scope, so the stops above do not reach them: each has its own
 * stop, and that one is final (the run is cancelled and the conversation
 * released). It asks once before it does so, in the row, without a dialog.
 */
export function RunningDiscussions({ discussions, loadFailed, busy, onStop }: RunningDiscussionsProps): React.ReactElement | null {
  const t = useTranslations('operatorAgents.execution');
  const format = useFormatter();
  const [confirming, setConfirming] = useState<string | null>(null);

  if (discussions.length === 0 && !loadFailed) return null;

  const when = (iso: string): string => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  function row(d: RunningDiscussionDto): React.ReactElement {
    const details = [
      d.opened_by ? t('discussionOpenedBy', { agent: d.opened_by }) : null,
      d.participants.length > 0 ? t('discussionParticipants', { agents: d.participants.join(', ') }) : null,
      d.started_at ? t('discussionStarted', { when: when(d.started_at) }) : null,
      d.expires_at ? t('discussionExpires', { when: when(d.expires_at) }) : null,
    ].filter((part): part is string => part !== null);
    return (
      <li
        key={d.workflow_id}
        data-testid={`running-discussion-${d.workflow_id}`}
        className="flex flex-wrap items-center justify-between gap-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-2 text-sm"
      >
        <span className="min-w-0">
          {d.topic ?? t('discussionNoTopic', { slug: d.slug })}
          {d.stop_requested_at ? (
            <span className="ml-2 rounded bg-[color:var(--danger)] px-1.5 py-0.5 text-xs text-white">{t('discussionStopRequested')}</span>
          ) : null}
          <span className="block text-xs text-[color:var(--fg-muted)]">{details.join(' · ')}</span>
          {d.conversation ? (
            <span className="block truncate text-xs text-[color:var(--fg-muted)]" title={d.conversation.conversation_id}>
              {t('discussionConversation', { channel: d.conversation.channel_type, conversation: d.conversation.conversation_id })}
            </span>
          ) : null}
          {d.incomplete ? <span className="block text-xs text-[color:var(--danger)]">{t('discussionIncomplete')}</span> : null}
        </span>
        {confirming === d.workflow_id ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs">{t('discussionStopConfirm')}</span>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirming(null);
                onStop(d.workflow_id);
              }}
            >
              {t('discussionStopYes')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
              {t('discussionStopNo')}
            </Button>
          </span>
        ) : (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(d.workflow_id)}>
            {t('discussionStop')}
          </Button>
        )}
      </li>
    );
  }

  return (
    <div className="space-y-2" data-testid="running-discussions">
      <h3 className="text-sm font-medium">{t('discussionsHeading')}</h3>
      <p className="max-w-3xl text-xs text-[color:var(--fg-muted)]">{t('discussionsIntro')}</p>
      {loadFailed ? <p className="text-sm text-[color:var(--danger)]">{t('discussionsLoadFailed')}</p> : null}
      {discussions.length > 0 ? <ul className="space-y-2">{discussions.map(row)}</ul> : null}
    </div>
  );
}
