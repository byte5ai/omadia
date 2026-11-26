'use client';

import { useCallback, useEffect, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

import {
  ApiError,
  deleteOwnerlessMemory,
  listOwnerlessMemories,
  type OwnerlessMemory,
} from '../../_lib/api';

/**
 * ADR-0185 (#1829, #1831) — memorable knowledge nobody owns: entries the
 * scratch reaper consolidated, rules from `/memories/_rules/`, and rules
 * planted before ADR-0033. No owner can delete them, so this panel lists them
 * and deletes one at a time. Rules come back from their seed file; deleting
 * a rule entry here only helps for an orphan whose file is already gone.
 */
export function OwnerlessMemoriesPanel(): React.ReactElement {
  const t = useTranslations('adminDangerZone.ownerless');
  const format = useFormatter();
  const [items, setItems] = useState<OwnerlessMemory[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const describe = useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        if (err.status === 409) return t('errorHasOwners');
        if (err.status === 404) return t('errorNotFound');
        if (err.status === 403 || err.status === 401) return t('errorForbidden');
      }
      return t('errorGeneric');
    },
    [t],
  );

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await listOwnerlessMemories();
      setSupported(res.supported);
      setItems(res.items);
    } catch (err) {
      setError(describe(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [describe]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setPendingId(id);
      setError(null);
      try {
        await deleteOwnerlessMemory(id);
        setItems((prev) => prev.filter((item) => item.id !== id));
      } catch (err) {
        setError(describe(err));
      } finally {
        setPendingId(null);
      }
    },
    [describe],
  );

  return (
    <section className="mt-8 rounded-lg border border-[color:var(--border)] p-4">
      <h2 className="mb-1 text-sm font-semibold">{t('title')}</h2>
      <p className="mb-3 text-sm text-[color:var(--fg-muted)]">{t('intro')}</p>
      {error !== null && (
        <p role="alert" className="mb-3 text-sm text-[color:var(--danger)]">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
      ) : !supported ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('unsupported')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
      ) : (
        <ul className="divide-y divide-[color:var(--border)]">
          {items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{item.summary}</p>
                <p className="text-xs text-[color:var(--fg-muted)]">
                  {item.isRule
                    ? t('sourceRule')
                    : t('sourceSystem', { createdBy: item.createdBy ?? '—', agent: item.originAgent ?? '—' })}
                  {item.createdAt !== null && (
                    <> · {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</>
                  )}
                </p>
              </div>
              <Button
                variant="danger"
                onClick={() => void remove(item.id)}
                disabled={pendingId !== null}
                aria-label={t('deleteAria', { summary: item.summary })}
              >
                {pendingId === item.id ? t('deleting') : t('delete')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
