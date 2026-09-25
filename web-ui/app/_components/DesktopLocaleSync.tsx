'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';

import { pushDesktopUiLocale } from '../_lib/desktopShell';

/**
 * Tells the desktop shell which language the UI is showing (#1074), so the
 * shell's own dialogs and menu headings follow it instead of the OS language.
 *
 * Mounted once in the root layout, inside `NextIntlClientProvider`. It reports
 * on first load and again whenever the provider's locale changes, which is
 * what `LocaleSwitcher`'s `router.refresh()` does. Unlike `DesktopUiReady` it
 * runs on every route, `/login` and `/setup` included. In a plain browser the
 * bridge is absent and this does nothing. Renders nothing.
 */
export function DesktopLocaleSync(): null {
  const locale = useLocale();

  useEffect(() => {
    pushDesktopUiLocale(locale);
  }, [locale]);

  return null;
}
