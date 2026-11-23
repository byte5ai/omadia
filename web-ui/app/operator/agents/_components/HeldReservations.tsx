'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import type { HeldReservationDto } from '../../../_lib/agents';

interface HeldReservationsProps {
  reservations: readonly HeldReservationDto[];
  busy: boolean;
  onRelease: (id: string) => void;
}

/**
 * Rollout defect D34 — every conversation that is held right now.
 *
 * One conversation has one holder: a process of an archetype plugin (a
 * facilitation) or an agent discussion. While it is held nothing else starts
 * there. A reservation whose holder is gone used to block a conversation
 * with nothing on this page to show for it; listing them all, whoever holds
 * them, is what makes that visible. Releasing frees the conversation and
 * ends nothing; it asks once in the row.
 */
export function HeldReservations({ reservations, busy, onRelease }: HeldReservationsProps): React.ReactElement | null {
  const t = useTranslations('operatorAgents.execution');
  const format = useFormatter();
  const [confirming, setConfirming] = useState<string | null>(null);

  if (reservations.length === 0) return null;

  const when = (iso: string): string => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="space-y-2" data-testid="held-reservations">
      <h3 className="text-sm font-medium">{t('reservationsHeading')}</h3>
      <p className="max-w-3xl text-xs text-[color:var(--fg-muted)]">{t('reservationsIntro')}</p>
      <ul className="space-y-2">
        {reservations.map((r) => (
          <li
            key={r.id}
            data-testid={`held-reservation-${r.id}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-4 py-2 text-sm"
          >
            <span className="min-w-0">
              <span className="block truncate" title={r.conversation_id}>
                {t('discussionConversation', { channel: r.channel_type, conversation: r.conversation_id })}
              </span>
              <span className="block text-xs text-[color:var(--fg-muted)]">
                {r.holder_kind === 'agent_discussion'
                  ? t('reservationHeldByDiscussion', { when: when(r.reserved_at) })
                  : t('reservationHeldByProcess', {
                      agent: r.agent_slug ?? r.plugin_id ?? '',
                      process: r.process_id,
                      when: when(r.reserved_at),
                    })}
              </span>
            </span>
            {confirming === r.id ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-xs">{t('reservationReleaseConfirm')}</span>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null);
                    onRelease(r.id);
                  }}
                >
                  {t('reservationReleaseYes')}
                </Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
                  {t('reservationReleaseNo')}
                </Button>
              </span>
            ) : (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(r.id)}>
                {t('reservationRelease')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
