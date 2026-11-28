'use client';

import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { type SandboxDto, teardownSandbox } from '../../../_lib/adminSandboxes';
import {
  CELL_CLASS,
  ConfirmButton,
  ErrorLine,
  Mono,
  ROW_CLASS,
  TableFrame,
  THEAD_CLASS,
  useDateText,
  useErrorText,
} from '../../_components/AdminSurface';

export function SandboxTable({
  sandboxes,
  onChanged,
}: {
  sandboxes: readonly SandboxDto[];
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const t = useTranslations('adminSandboxes.list');
  const date = useDateText();
  const errorText = useErrorText({
    'sandbox_admin.teardown_failed': t('errors.teardownFailed'),
    'sandbox_admin.not_found': t('errors.notFound'),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function remove(scopeKey: string): Promise<void> {
    setBusy(scopeKey);
    setError(null);
    try {
      await teardownSandbox(scopeKey);
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error !== null ? <ErrorLine text={errorText(error)} /> : null}
      <TableFrame>
        <thead className={THEAD_CLASS}>
          <tr>
            <th className={CELL_CLASS}>{t('scope')}</th>
            <th className={CELL_CLASS}>{t('container')}</th>
            <th className={CELL_CLASS}>{t('profile')}</th>
            <th className={CELL_CLASS}>{t('lastUsed')}</th>
            <th className={CELL_CLASS}>{t('created')}</th>
            <th className={CELL_CLASS}>
              <span className="sr-only">{t('actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sandboxes.map((s) => (
            <tr key={s.scope_key} className={ROW_CLASS}>
              <td className={CELL_CLASS}>
                <Mono>{s.scope_key}</Mono>
              </td>
              <td className={CELL_CLASS}>
                <Mono>{s.sandbox_ref}</Mono>
              </td>
              <td className={CELL_CLASS}>
                {[s.persistent ? t('persistent') : t('ephemeral'), s.egress ? t('egressOn') : t('egressOff')].join(' · ')}
              </td>
              <td className={`${CELL_CLASS} whitespace-nowrap text-xs`}>{date(s.last_used_at)}</td>
              <td className={`${CELL_CLASS} whitespace-nowrap text-xs text-[color:var(--fg-muted)]`}>
                {date(s.created_at)}
              </td>
              <td className={CELL_CLASS}>
                <ConfirmButton
                  label={t('teardown')}
                  confirmLabel={t('confirmTeardown')}
                  busy={busy === s.scope_key}
                  onConfirm={() => void remove(s.scope_key)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
    </div>
  );
}
