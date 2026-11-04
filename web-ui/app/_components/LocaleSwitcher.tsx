'use client';

import { Check } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  LOCALE_COOKIE,
  LOCALE_LABELS,
  LOCALES,
  type Locale,
} from '../../i18n/locales';
import { LocaleFlag } from './LocaleFlag';

/** Current locale + a switcher that writes the cookie and re-renders the RSC tree. */
function useLocaleSwitch(): {
  readonly currentLocale: Locale;
  readonly pending: boolean;
  readonly switchTo: (next: Locale) => void;
} {
  const currentLocale = useLocale() as Locale;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function switchTo(next: Locale): void {
    if (next === currentLocale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    startTransition(() => {
      router.refresh();
    });
  }

  return { currentLocale, pending, switchTo };
}

/** Language select — lives in the signed-in user menu. */
export function LocaleSwitcher(): React.ReactElement {
  const t = useTranslations('localeSwitcher');
  const { currentLocale, pending, switchTo } = useLocaleSwitch();

  return (
    <label className="relative inline-flex w-40 items-center" aria-label={t('ariaLabel')}>
      <select
        value={currentLocale}
        onChange={(e) => switchTo(e.target.value as Locale)}
        disabled={pending}
        className="w-full appearance-none rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-xs text-[color:var(--fg-muted)] outline-none transition-colors hover:text-[color:var(--fg-strong)] focus:border-[color:var(--accent)] disabled:opacity-50"
      >
        {LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {LOCALE_LABELS[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Flag-triggered language menu for the signed-out header. Closes on an
 * outside mousedown and on Escape (focus returns to the trigger), mirroring
 * the Nav/AuthBadge dropdowns. Only mounted while open.
 */
export function LocaleFlagMenu(): React.ReactElement {
  const t = useTranslations('localeSwitcher');
  const { currentLocale, pending, switchTo } = useLocaleSwitch();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      {/* eslint-disable-next-line no-restricted-syntax -- icon-only header trigger (flag), same chrome as the issue button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded p-1.5 text-[color:var(--fg-muted)] transition hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)] disabled:opacity-50"
        title={t('ariaLabel')}
        aria-label={t('ariaLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
      >
        <LocaleFlag locale={currentLocale} />
        <svg
          className="h-2.5 w-2.5"
          viewBox="0 0 12 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M1 1.5 6 6.5 11 1.5" />
        </svg>
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={t('ariaLabel')}
          className="absolute right-0 top-full z-50 mt-2 min-w-[160px] rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] py-1 shadow-lg"
        >
          {LOCALES.map((locale) => {
            const active = locale === currentLocale;
            return (
              // eslint-disable-next-line no-restricted-syntax -- menu row (menuitemradio), not a §4.2 CTA
              <button
                key={locale}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                lang={locale}
                onClick={() => {
                  setOpen(false);
                  switchTo(locale);
                }}
                className={[
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                  active
                    ? 'bg-[color:var(--bg-soft)] text-[color:var(--ink)]'
                    : 'text-[color:var(--muted-ink)] hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--ink)]',
                ].join(' ')}
              >
                <LocaleFlag locale={locale} />
                <span className="flex-1">{LOCALE_LABELS[locale]}</span>
                {active ? <Check className="h-3.5 w-3.5 text-[color:var(--accent)]" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
