'use client';

import { useTranslations } from 'next-intl';

import { ApiError } from '@/app/_lib/api';

/** Shared styling + error-formatting for the API-keys admin panel — mirrors
 *  the same tiny per-feature `shared.tsx` pattern already used by
 *  `admin/webhooks/_components/shared.tsx` rather than reaching for a
 *  cross-feature util module. */

export const inputCls =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';

export const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

/** Scope / data chip — Geist Mono register per the Lume type-scale (§2.7,
 *  `.type-mono-data`), since a scope string is data, not UI chrome. */
export const chipCls =
  'type-mono-data inline-flex items-center rounded-full border border-[color:var(--border)] px-2 py-0.5 text-[11px] lowercase text-[color:var(--fg-muted)]';

export function toFriendlyError(err: unknown): string {
  if (err instanceof ApiError) return err.body || err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Active/revoked status — text + a 1px edge + at most a light tint, never a
 * solid-filled pill (Lume state-color rule, spec §2.6). Same recipe as
 * `admin/webhooks/_components/shared.tsx`'s `StatusBadge`.
 */
export function KeyStatusBadge({ revokedAt }: { revokedAt?: number }): React.ReactElement {
  const t = useTranslations('adminApiKeys.list.status');
  const revoked = revokedAt !== undefined;
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
        revoked
          ? 'border-[color:var(--danger-edge)]/50 bg-[color:var(--danger)]/8 text-[color:var(--danger)]'
          : 'border-[color:var(--success)]/50 bg-[color:var(--success)]/8 text-[color:var(--success)]',
      ].join(' ')}
    >
      {revoked ? t('revoked') : t('active')}
    </span>
  );
}
