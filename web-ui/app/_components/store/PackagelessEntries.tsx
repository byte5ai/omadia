import { getTranslations } from 'next-intl/server';

import type { PackagelessEntry } from '../../_lib/packagelessEntries';

import { RemovePackagelessEntryButton } from './RemovePackagelessEntryButton';

/**
 * Installed entries without a package (see `_lib/packagelessEntries.ts`).
 * Shown on the store's installed tab; renders nothing when there is none.
 */
export async function PackagelessEntries({
  entries,
}: {
  entries: PackagelessEntry[];
}): Promise<React.ReactElement | null> {
  if (entries.length === 0) return null;
  const t = await getTranslations('store.packageless');
  return (
    <div
      role="status"
      data-testid="store-packageless-entries"
      className="mt-6 rounded-lg border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/6 p-4"
    >
      <p className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
        {t('title', { count: entries.length })}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">{t('body')}</p>
      <ul className="mt-2 flex flex-col gap-1">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2 text-[13px] text-[color:var(--fg-muted)]">
            <span className="font-mono-num font-semibold text-[color:var(--fg)]">{entry.id}</span>
            <span className="font-mono-num text-[12px] text-[color:var(--fg-subtle)]">
              {t('version', { version: entry.version })}
            </span>
            <span className="rounded-full border border-[color:var(--warning)]/50 px-2 text-[11px] text-[color:var(--fg)]">
              {t('badge')}
            </span>
            <RemovePackagelessEntryButton id={entry.id} />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">{t('hint')}</p>
    </div>
  );
}
