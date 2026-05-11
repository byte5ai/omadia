'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  LOCALE_COOKIE,
  LOCALE_LABELS,
  LOCALES,
  type Locale,
} from '../../i18n/locales';

export function LocaleSwitcher(): React.ReactElement {
  const t = useTranslations('localeSwitcher');
  const currentLocale = useLocale() as Locale;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleChange(next: Locale): void {
    if (next === currentLocale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <label className="relative inline-flex items-center" aria-label={t('ariaLabel')}>
      <select
        value={currentLocale}
        onChange={(e) => handleChange(e.target.value as Locale)}
        disabled={pending}
        className="appearance-none rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-xs uppercase tracking-[0.18em] text-[color:var(--muted-ink)] outline-none transition-colors hover:text-[color:var(--ink)] focus:border-[color:var(--accent)] disabled:opacity-50"
      >
        {LOCALES.map((locale) => (
          <option key={locale} value={locale} className="bg-[color:var(--bg)] text-[color:var(--ink)]">
            {locale.toUpperCase()} · {LOCALE_LABELS[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}
