'use client';

import { Fragment, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { type CredentialDto, revokeCredential } from '../../../_lib/adminCredentials';
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
import { GrantList } from './GrantList';

/**
 * The keychain's credentials. "Revoke" shows only where the server said
 * `can_revoke` (personal: owner only; service: any operator) — the server
 * enforces it either way.
 */
export function CredentialTable({
  credentials,
  onChanged,
}: {
  credentials: readonly CredentialDto[];
  onChanged: () => Promise<void>;
}): React.ReactElement {
  const t = useTranslations('adminCredentials.list');
  const date = useDateText();
  const errorText = useErrorText({
    'credential.forbidden': t('errors.forbidden'),
    'credential.already_revoked': t('errors.alreadyRevoked'),
    'credential.not_found': t('errors.notFound'),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(id: string): Promise<void> {
    setBusyId(id);
    setError(null);
    try {
      await revokeCredential(id);
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
            <th className={CELL_CLASS}>{t('name')}</th>
            <th className={CELL_CLASS}>{t('kind')}</th>
            <th className={CELL_CLASS}>{t('owner')}</th>
            <th className={CELL_CLASS}>{t('broker')}</th>
            <th className={CELL_CLASS}>{t('created')}</th>
            <th className={CELL_CLASS}>{t('state')}</th>
            <th className={CELL_CLASS}>
              <span className="sr-only">{t('actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {credentials.map((c) => (
            <Fragment key={c.id}>
              <tr className={ROW_CLASS}>
                <td className={`${CELL_CLASS} font-medium`}>{c.name}</td>
                <td className={CELL_CLASS}>{t(`kinds.${c.kind}`)}</td>
                <td className={CELL_CLASS}>{c.owner ? <Mono>{c.owner}</Mono> : t('noOwner')}</td>
                <td className={CELL_CLASS}>
                  {c.broker ? (
                    <Mono>
                      {c.broker.allowed_methods.join(',')} {c.broker.host}
                      {c.broker.path_prefixes.join(' ')}
                    </Mono>
                  ) : (
                    t('noBroker')
                  )}
                </td>
                <td className={`${CELL_CLASS} whitespace-nowrap text-xs text-[color:var(--fg-muted)]`}>
                  {date(c.created_at)}
                </td>
                <td className={CELL_CLASS}>
                  {c.revoked_at ? t('revokedAt', { date: date(c.revoked_at) }) : t('active')}
                </td>
                <td className={`${CELL_CLASS} whitespace-nowrap`}>
                  <span className="inline-flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setOpen(open === c.id ? null : c.id)}>
                      {open === c.id ? t('hideGrants') : t('showGrants')}
                    </Button>
                    {c.can_revoke ? (
                      <ConfirmButton
                        label={t('revoke')}
                        confirmLabel={t('confirmRevoke')}
                        busy={busyId === c.id}
                        onConfirm={() => void revoke(c.id)}
                      />
                    ) : null}
                  </span>
                </td>
              </tr>
              {open === c.id ? (
                <tr className={ROW_CLASS}>
                  <td className={CELL_CLASS} colSpan={7}>
                    <GrantList credentialId={c.id} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </TableFrame>
    </div>
  );
}
