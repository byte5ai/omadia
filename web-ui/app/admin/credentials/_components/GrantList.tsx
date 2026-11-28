'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  type CredentialGrantDto,
  type CredentialGrantsResponse,
  listCredentialGrants,
  revokeCredentialGrant,
} from '../../../_lib/adminCredentials';
import { ConfirmButton, ErrorLine, Mono, MutedLine, useDateText, useErrorText, enumLabel } from '../../_components/AdminSurface';

/** The grants of one credential, loaded when its row is opened. */
export function GrantList({ credentialId }: { credentialId: string }): React.ReactElement {
  const t = useTranslations('adminCredentials.grants');
  const date = useDateText();
  const errorText = useErrorText({
    'credential.forbidden': t('errors.forbidden'),
    'credential.grant_already_revoked': t('errors.alreadyRevoked'),
    'credential.grant_not_found': t('errors.notFound'),
  });
  const [data, setData] = useState<CredentialGrantsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await listCredentialGrants(credentialId);
        if (!cancelled) setData(next);
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [credentialId, generation]);

  async function revoke(grant: CredentialGrantDto): Promise<void> {
    setBusyId(grant.id);
    setError(null);
    try {
      await revokeCredentialGrant(grant.id);
      setGeneration((g) => g + 1);
    } catch (err) {
      setError(err);
    } finally {
      setBusyId(null);
    }
  }

  if (error !== null && !data) return <ErrorLine text={errorText(error)} />;
  if (!data) return <MutedLine text={t('loading')} />;
  if (data.grants.length === 0) return <MutedLine text={t('empty')} />;

  return (
    <div className="flex flex-col gap-2">
      {error !== null ? <ErrorLine text={errorText(error)} /> : null}
      <ul className="flex flex-col gap-2">
        {data.grants.map((g) => (
          <li
            key={g.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[color:var(--border)]/60 px-3 py-2"
          >
            <div className="flex flex-col gap-1">
              <span>
                <Mono>{g.principal}</Mono> · {enumLabel(t, 'modes', g.mode)} · {g.purpose}
              </span>
              <span className="text-xs text-[color:var(--fg-muted)]">
                {t('meta', {
                  grantedBy: g.granted_by,
                  grantedAt: date(g.granted_at),
                  expiresAt: date(g.expires_at),
                })}
              </span>
            </div>
            {g.revoked_at ? (
              <span className="text-xs text-[color:var(--fg-muted)]">
                {t('revokedAt', { date: date(g.revoked_at) })}
              </span>
            ) : g.consumed_at ? (
              <span className="text-xs text-[color:var(--fg-muted)]">
                {t('consumedAt', { date: date(g.consumed_at) })}
              </span>
            ) : data.can_revoke_grants ? (
              <ConfirmButton
                label={t('revoke')}
                confirmLabel={t('confirmRevoke')}
                busy={busyId === g.id}
                onConfirm={() => void revoke(g)}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
