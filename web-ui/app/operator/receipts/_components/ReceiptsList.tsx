'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { PrivacyReceiptCard } from '../../../_components/chat/PrivacyReceiptCard';
import { Button } from '../../../_components/ui/Button';
import {
  listReceipts,
  type ReceiptsPageDto,
  type TurnReceiptDto,
} from '../../../_lib/receipts';

interface ReceiptsListProps {
  initial: ReceiptsPageDto;
}

/**
 * #757 — expandable per-turn receipt rows with cursor pagination. Each row
 * shows routing metadata (when, scope, channel, model) plus the shield's
 * headline counts; expanding renders the exact `PrivacyReceiptCard` the
 * user saw in the chat — the record and the UI share one truth.
 */
export function ReceiptsList({ initial }: ReceiptsListProps): React.ReactElement {
  const t = useTranslations('operatorReceipts');
  const format = useFormatter();
  const [items, setItems] = useState<TurnReceiptDto[]>(initial.items);
  const [nextCursor, setNextCursor] = useState<string | undefined>(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function loadMore(): Promise<void> {
    if (!nextCursor || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const page = await listReceipts({ cursor: nextCursor, limit: 25 });
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      setLoadError(t('loadError'));
    } finally {
      setLoading(false);
    }
  }

  if (items.length === 0) {
    return (
      <p className="rounded border border-[color:var(--edge)] p-6 text-sm text-[color:var(--fg-muted)]">
        {t('empty')}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {items.map((item) => (
          <li
            key={item.turnId}
            className="rounded border border-[color:var(--edge)] p-4"
          >
            <details>
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
                <time
                  dateTime={item.createdAt}
                  className="font-medium tabular-nums"
                >
                  {format.dateTime(new Date(item.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
                {item.sessionScope ? (
                  <span className="text-[color:var(--fg-muted)]">
                    {t('scopeLabel')}: {item.sessionScope}
                  </span>
                ) : null}
                {item.channel ? (
                  <span className="text-[color:var(--fg-muted)]">
                    {t('channelLabel')}: {item.channel}
                  </span>
                ) : null}
                {item.model ? (
                  <span className="text-[color:var(--fg-muted)]">
                    {t('modelLabel')}: {item.model}
                  </span>
                ) : null}
                <span className="text-[color:var(--fg-muted)]">
                  {t('summaryCounts', {
                    masked: item.receipt.fieldsMasked,
                    datasets: item.receipt.datasetsInterned,
                  })}
                </span>
              </summary>
              <div className="mt-3">
                <PrivacyReceiptCard receipt={item.receipt} />
                <p className="mt-2 break-all text-xs text-[color:var(--fg-muted)]">
                  {t('turnIdLabel')}: {item.turnId}
                </p>
              </div>
            </details>
          </li>
        ))}
      </ul>
      {loadError ? (
        <p className="text-sm text-[color:var(--danger)]">{loadError}</p>
      ) : null}
      {nextCursor ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => void loadMore()}
          disabled={loading}
          busy={loading}
          busyLabel={t('loadingMore')}
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
