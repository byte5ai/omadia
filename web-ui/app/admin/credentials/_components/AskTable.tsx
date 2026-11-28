'use client';

import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { cancelAsk, type CredentialAskDto, resolveAsk } from '../../../_lib/adminCredentials';
import {
  CELL_CLASS,
  ErrorLine,
  Mono,
  ROW_CLASS,
  TableFrame,
  THEAD_CLASS,
  useDateText,
  useErrorText,
} from '../../_components/AdminSurface';

/**
 * One table for both ask lists. `owner` rows (the inbox) offer approve and
 * deny — the server allows them to the owner only (ADR-0102, no admin
 * override); `requester` rows offer cancel while the ask is pending.
 */
export function AskTable({
  asks,
  names,
  role,
  onChanged,
}: {
  asks: readonly CredentialAskDto[];
  names: ReadonlyMap<string, string>;
  role: 'owner' | 'requester';
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const t = useTranslations('adminCredentials.asks');
  const date = useDateText();
  const errorText = useErrorText({
    'credential_ask.forbidden': t('errors.forbidden'),
    'credential_ask.not_actionable': t('errors.notActionable'),
    'credential_ask.not_found': t('errors.notFound'),
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(id: string, action: () => Promise<void>): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <ErrorLine text={error} /> : null}
      <TableFrame>
        <thead className={THEAD_CLASS}>
          <tr>
            <th className={CELL_CLASS}>{t('credential')}</th>
            <th className={CELL_CLASS}>{role === 'owner' ? t('requester') : t('owner')}</th>
            <th className={CELL_CLASS}>{t('purpose')}</th>
            <th className={CELL_CLASS}>{t('mode')}</th>
            <th className={CELL_CLASS}>{t('status')}</th>
            <th className={CELL_CLASS}>{t('expires')}</th>
            <th className={CELL_CLASS}>
              <span className="sr-only">{t('actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {asks.map((ask) => (
            <tr key={ask.id} className={ROW_CLASS}>
              <td className={CELL_CLASS}>{names.get(ask.credential_id) ?? <Mono>{ask.credential_id}</Mono>}</td>
              <td className={CELL_CLASS}>
                <Mono>{role === 'owner' ? ask.requester : ask.owner}</Mono>
              </td>
              <td className={CELL_CLASS}>{ask.purpose}</td>
              <td className={CELL_CLASS}>{t(`modes.${ask.mode}`)}</td>
              <td className={CELL_CLASS}>{t(`statuses.${ask.status}`)}</td>
              <td className={`${CELL_CLASS} whitespace-nowrap text-xs text-[color:var(--fg-muted)]`}>
                {date(ask.ask_expires_at)}
              </td>
              <td className={`${CELL_CLASS} whitespace-nowrap`}>
                {ask.status !== 'pending' ? null : role === 'owner' ? (
                  <span className="inline-flex gap-2">
                    <Button
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() => void run(ask.id, () => resolveAsk(ask.id, 'approve'))}
                    >
                      {t('approve')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() => void run(ask.id, () => resolveAsk(ask.id, 'deny'))}
                    >
                      {t('deny')}
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => void run(ask.id, () => cancelAsk(ask.id))}
                  >
                    {t('cancel')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
    </div>
  );
}
