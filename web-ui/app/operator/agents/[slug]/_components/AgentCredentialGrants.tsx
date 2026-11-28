'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { type CredentialDto, listCredentials } from '../../../../_lib/adminCredentials';
import {
  type AgentCredentialGrantDto,
  grantAgentCredential,
  listAgentCredentialGrants,
  removeAgentCredentialGrant,
} from '../../../../_lib/agentCredentialGrants';
import {
  CELL_CLASS,
  ConfirmButton,
  ErrorLine,
  Mono,
  MutedLine,
  ROW_CLASS,
  TableFrame,
  THEAD_CLASS,
  enumLabel,
  useDateText,
  useErrorText,
} from '../../../../admin/_components/AdminSurface';

interface AgentCredentialGrantsProps {
  readonly slug: string;
  /** Called after a grant or removal, so the page re-reads the agent's reach. */
  readonly onChanged?: () => void;
}

/**
 * #2320 / #2319 — the named credentials an agent may use through
 * `credentialBroker@1` (ADR-0290). Granting never shares a secret and never
 * lets anyone use a credential they could not use before: the broker still
 * needs the turn account's own grant (ADR-0102, ADR-0355). Every change is
 * audited server-side as `agent.credential_grant_change`.
 */
export function AgentCredentialGrants({ slug, onChanged }: AgentCredentialGrantsProps): React.ReactElement {
  const t = useTranslations('agentCredentialGrants');
  const date = useDateText();
  const errorText = useErrorText({
    credential_not_found: t('errors.notFound'),
    credential_revoked: t('errors.revoked'),
    preview_draft_agent: t('errors.previewDraft'),
    not_found: t('errors.notFound'),
  });
  const [grants, setGrants] = useState<AgentCredentialGrantDto[] | null>(null);
  const [keychain, setKeychain] = useState<CredentialDto[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextGrants, nextKeychain] = await Promise.all([listAgentCredentialGrants(slug), listCredentials()]);
        if (cancelled) return;
        setGrants(nextGrants);
        setKeychain(nextKeychain.filter((c) => c.revoked_at === null));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // errorText is rebuilt each render; the load follows slug and generation only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, generation]);

  const run = useCallback(
    async (label: string, op: () => Promise<void>): Promise<void> => {
      setBusy(label);
      setError(null);
      try {
        await op();
        setGeneration((g) => g + 1);
        onChanged?.();
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(null);
      }
    },
    [errorText, onChanged],
  );

  const granted = new Set((grants ?? []).map((g) => g.credentialId));
  const offer = keychain.filter((c) => !granted.has(c.id));

  return (
    <section
      data-testid="agent-credential-grants"
      className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4"
    >
      <h2 className="mb-1 text-lg font-medium">{t('heading')}</h2>
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('hint')}</p>
      <div className="flex flex-col gap-3">
        {error ? <ErrorLine text={error} /> : null}
        {grants === null ? (
          error ? null : <MutedLine text={t('loading')} />
        ) : grants.length === 0 ? (
          <MutedLine text={t('empty')} />
        ) : (
          <TableFrame>
            <thead className={THEAD_CLASS}>
              <tr>
                <th className={CELL_CLASS}>{t('name')}</th>
                <th className={CELL_CLASS}>{t('kind')}</th>
                <th className={CELL_CLASS}>{t('host')}</th>
                <th className={CELL_CLASS}>{t('granted')}</th>
                <th className={CELL_CLASS}>
                  <span className="sr-only">{t('actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.credentialId} className={ROW_CLASS}>
                  <td className={`${CELL_CLASS} font-medium`}>
                    {g.name ?? <Mono>{g.credentialId}</Mono>}
                    {g.revoked ? (
                      <span className="ml-2 text-xs text-[color:var(--danger)]">{t('revoked')}</span>
                    ) : null}
                  </td>
                  <td className={CELL_CLASS}>{g.kind ? enumLabel(t, 'kinds', g.kind) : t('unknown')}</td>
                  <td className={CELL_CLASS}>{g.host ? <Mono>{g.host}</Mono> : t('noHost')}</td>
                  <td className={`${CELL_CLASS} whitespace-nowrap text-xs text-[color:var(--fg-muted)]`}>
                    {t('grantedBy', { who: g.grantedBy, date: date(g.grantedAt) })}
                  </td>
                  <td className={`${CELL_CLASS} whitespace-nowrap`}>
                    <ConfirmButton
                      label={t('remove')}
                      confirmLabel={t('confirmRemove')}
                      busy={busy === g.credentialId}
                      onConfirm={() => void run(g.credentialId, () => removeAgentCredentialGrant(slug, g.credentialId))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        )}
        {grants !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm" htmlFor={`agent-credential-${slug}`}>
              {t('addLabel')}
            </label>
            <select
              id={`agent-credential-${slug}`}
              className="rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 text-sm"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={offer.length === 0}
            >
              <option value="">{offer.length === 0 ? t('noneLeft') : t('choose')}</option>
              {offer.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.broker ? t('option', { name: c.name, host: c.broker.host }) : c.name}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              disabled={selected === ''}
              busy={busy === 'add'}
              busyLabel={t('adding')}
              onClick={() =>
                void run('add', async () => {
                  await grantAgentCredential(slug, selected);
                  setSelected('');
                })
              }
            >
              {t('add')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
