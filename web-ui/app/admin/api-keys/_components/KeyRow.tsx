'use client';

import { useCallback, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { listApiKeyUsage, type ApiKeyPublicView, type ApiKeyUsageEntry } from '@/app/_lib/api';

import { CopyIdButton, KeyStatusBadge, card, chipCls, keyStatusOf } from './shared';

type Confirming = 'revoke' | 'delete' | null;

type UsageState =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'ready'; entries: ApiKeyUsageEntry[] }
  | { kind: 'error' };

interface KeyRowProps {
  apiKey: ApiKeyPublicView;
  now: number;
  /** True while this row's revoke or delete request is in flight. */
  pending: boolean;
  onRevoke: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/**
 * One key in the list. #1328: owner, expiry (with an Expired status) and a
 * delete action for revoked or expired keys. #1329: "last used" and the
 * key's recent requests from the usage log.
 */
export function KeyRow({ apiKey, now, pending, onRevoke, onDelete }: KeyRowProps): React.ReactElement {
  const t = useTranslations('adminApiKeys.list');
  const format = useFormatter();
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [usage, setUsage] = useState<UsageState>({ kind: 'hidden' });

  const status = keyStatusOf(apiKey, now);
  const fmt = (ms: number): string =>
    format.dateTime(new Date(ms), { dateStyle: 'medium', timeStyle: 'short' });

  const onToggleUsage = useCallback(async (): Promise<void> => {
    if (usage.kind !== 'hidden') {
      setUsage({ kind: 'hidden' });
      return;
    }
    setUsage({ kind: 'loading' });
    try {
      const { entries } = await listApiKeyUsage(apiKey.id);
      setUsage({ kind: 'ready', entries });
    } catch {
      setUsage({ kind: 'error' });
    }
  }, [apiKey.id, usage.kind]);

  const onConfirm = useCallback(async (): Promise<void> => {
    if (confirming === 'revoke') await onRevoke(apiKey.id);
    if (confirming === 'delete') await onDelete(apiKey.id);
    setConfirming(null);
  }, [apiKey.id, confirming, onDelete, onRevoke]);

  return (
    <li className={card}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-[color:var(--fg-strong)]">
              {apiKey.label || t('unlabeled')}
            </span>
            <KeyStatusBadge status={status} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {apiKey.scopes.map((scope) => (
              <span key={scope} className={chipCls}>
                {scope}
              </span>
            ))}
          </div>
          {/* The id + copy affordance — the reason #567 exists (a public MCP
              binding is keyed on ApiKeyRecord.id). */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              {t('idLabel')}
            </span>
            <CopyIdButton id={apiKey.id} />
          </div>
          <span className="text-[12px] text-[color:var(--fg-muted)]">
            {t('rateLimitValue', { value: apiKey.rateLimitPerMinute })}
            {' · '}
            {t('createdAt', { date: fmt(apiKey.createdAt) })}
            {' · '}
            {apiKey.createdBy
              ? t('createdBy', { email: apiKey.createdBy.email })
              : t('createdByUnknown')}
          </span>
          <span className="text-[12px] text-[color:var(--fg-muted)]">
            {apiKey.lastUsedAt !== undefined
              ? t('lastUsed', { date: fmt(apiKey.lastUsedAt) })
              : t('neverUsed')}
            {apiKey.expiresAt !== undefined && (
              <>
                {' · '}
                {status === 'expired'
                  ? t('expiredAt', { date: fmt(apiKey.expiresAt) })
                  : t('expiresAt', { date: fmt(apiKey.expiresAt) })}
              </>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void onToggleUsage()}>
            {usage.kind === 'hidden' ? t('usage.show') : t('usage.hide')}
          </Button>
          {confirming === null && status === 'active' && (
            <Button variant="danger" size="sm" onClick={() => setConfirming('revoke')}>
              {t('revoke')}
            </Button>
          )}
          {confirming === null && status !== 'active' && (
            <Button variant="danger" size="sm" onClick={() => setConfirming('delete')}>
              {t('delete')}
            </Button>
          )}
        </div>
      </div>

      {confirming !== null && (
        <div className="mt-3 border-t border-[color:var(--border)] pt-3">
          <p className="mb-2 text-[13px] text-[color:var(--fg)]">
            {confirming === 'revoke' ? t('confirmRevoke.message') : t('confirmDelete.message')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={() => void onConfirm()}
              busy={pending}
              busyLabel={confirming === 'revoke' ? t('revoking') : t('deleting')}
            >
              {confirming === 'revoke' ? t('confirmRevoke.confirm') : t('confirmDelete.confirm')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(null)} disabled={pending}>
              {confirming === 'revoke' ? t('confirmRevoke.cancel') : t('confirmDelete.cancel')}
            </Button>
          </div>
        </div>
      )}

      {usage.kind !== 'hidden' && (
        <div className="mt-3 border-t border-[color:var(--border)] pt-3 text-[12px]">
          {usage.kind === 'loading' && <p className="text-[color:var(--fg-muted)]">{t('usage.loading')}</p>}
          {usage.kind === 'error' && <p className="text-[color:var(--danger)]">{t('usage.failed')}</p>}
          {usage.kind === 'ready' && usage.entries.length === 0 && (
            <p className="text-[color:var(--fg-muted)]">{t('usage.empty')}</p>
          )}
          {usage.kind === 'ready' && usage.entries.length > 0 && (
            <ul className="flex flex-col gap-1">
              {usage.entries.map((entry, i) => (
                <li key={`${entry.at}-${i}`} className="flex flex-wrap gap-3">
                  <span className="text-[color:var(--fg-muted)]">{fmt(entry.at)}</span>
                  <span className="type-mono-data">
                    {entry.method} {entry.route}
                  </span>
                  <span>{t(`usage.status.${entry.status}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}
