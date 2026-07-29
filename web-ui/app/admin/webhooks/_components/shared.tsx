'use client';

import { useTranslations } from 'next-intl';

import { ApiError } from '@/app/_lib/api';

/** Shared styling + error-formatting for the two webhook admin sections — kept
 *  in one place so the endpoints and subscriptions lists (issue #437) stay
 *  visually identical without copy-pasting class strings. */

export const inputCls =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

export const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

export function toFriendlyError(err: unknown): string {
  if (err instanceof ApiError) return err.body || err.message;
  return err instanceof Error ? err.message : String(err);
}

export function StatusBadge({ enabled }: { enabled: boolean }): React.ReactElement {
  const t = useTranslations('adminWebhooks.badge');
  return (
    <span
      className={[
        'inline-flex items-center gap-2 rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
        enabled
          ? 'bg-[color:var(--success)]/10 text-[color:var(--success)]'
          : 'bg-[color:var(--border)]/40 text-[color:var(--fg-muted)]',
      ].join(' ')}
    >
      {enabled ? t('enabled') : t('disabled')}
    </span>
  );
}
