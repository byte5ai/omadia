import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import {
  getLocale,
  getMessages,
  getTimeZone,
  getTranslations,
} from 'next-intl/server';

import { HeaderControls } from './_components/HeaderControls';
import { SessionWatcher } from './_components/SessionWatcher';
import { TimeZoneSync } from './_components/TimeZoneSync';
import { RuntimeReadinessBanner } from './_components/RuntimeReadinessBanner';
import { DesktopUiReady } from './_components/DesktopUiReady';
import { DesktopLocaleSync } from './_components/DesktopLocaleSync';
import { StreamRunner } from './_components/StreamRunner';
import { fontVariables } from './_fonts';
import { ChatSessionsProvider } from './_lib/chatSessionsContext';
import { StreamStoreProvider } from './_lib/streamStore';
import { fetchNavEntries } from './_lib/navigation';
import { SESSION_COOKIE, isFreshSessionToken } from './_lib/sessionToken';
import { UI_PREFS_COOKIE, parseUiPrefsCookie } from './_lib/uiPrefs';
import './globals.css';

/**
 * Typography per the Lume spec (§2.7) lives in `./_fonts` — three registers,
 * three variable families plus the wordmark face, loaded from woff2 files
 * vendored in this repo so the build never talks to a font CDN. That module
 * owns the CSS variables (--font-geist, --font-source-serif, --font-geist-mono,
 * --font-days-one); _lib/theme.css composes them into --font-sans /
 * --font-serif / --font-mono with platform-strongest fallbacks.
 */

/**
 * No-FOUC palette/theme (issue #287). The choice now lives in a server-side
 * per-user store (/api/v1/ui-prefs); the browser mirrors it into the
 * `omadia-ui-prefs` cookie, which ThemeControls writes on every change. We
 * read that cookie here in the RSC and render `data-palette`/`data-theme`
 * straight onto <html>, so the correct palette/mode is in the very first
 * server response — no flash, no client bootstrap script. ThemeControls
 * re-fetches the store on mount to seed/correct the cookie on a fresh device.
 *
 * The cookie name + shape and the parser live in `_lib/uiPrefs`, shared with
 * the API client and ThemeControls so the contract stays in one place.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('layout');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const locale = await getLocale();
  const messages = await getMessages();
  // The zone this response was rendered in (issue #1091). Stamped onto <html>
  // like `data-palette` so `TimeZoneSync` can tell whether the page in front of
  // the operator is already correct, and skip the refresh when it is.
  const timeZone = await getTimeZone();
  const t = await getTranslations('layout');
  const jar = await cookies();
  // Plugin-contributed menu entries, resolved for this locale server-side so
  // the nav is correct on first paint and stays on next-intl's single i18n
  // clock. Never throws — an unauthenticated visitor or an unreachable
  // middleware yields an empty list and the static nav renders alone.
  const navEntries = await fetchNavEntries(locale);
  // Signed-out visitors (only /login and /setup get past the proxy without a
  // session) see the minimal header. Decode-only, same check as the proxy.
  const signedIn = isFreshSessionToken(jar.get(SESSION_COOKIE)?.value);
  const { palette, theme } = parseUiPrefsCookie(jar.get(UI_PREFS_COOKIE)?.value);
  return (
    <html
      lang={locale}
      className={fontVariables}
      data-palette={palette}
      data-timezone={timeZone}
      {...(theme ? { 'data-theme': theme } : {})}
      suppressHydrationWarning
    >
      <body className="flex h-full flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ChatSessionsProvider>
            <StreamStoreProvider>
              <header className="app-header relative z-40 px-6 py-3 backdrop-blur">
                <div className="mx-auto flex max-w-[1280px] items-center gap-4">
                  <Link
                    href="/"
                    className="flex shrink-0 items-center transition-opacity hover:opacity-90"
                    aria-label={t('logoAriaLabel')}
                  >
                    {/* Wordmark and tagline side by side: with the
                        preferences in the user menu and no Dashboard entry,
                        the bar has room for them on one baseline. */}
                    <span className="flex items-baseline gap-3 whitespace-nowrap leading-none">
                      <span className="font-logo text-lg text-[color:var(--fg-strong)]">
                        omadia
                      </span>
                      <span className="hidden text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-muted)] sm:inline">
                        {t('tagline')}
                      </span>
                    </span>
                  </Link>
                  <HeaderControls signedIn={signedIn} navEntries={navEntries} />
                </div>
              </header>
              <div className="min-h-0 flex-1">{children}</div>
              {/* Headless stream runner — owns the fetch + NDJSON-parse loop
                  so switching menu route doesn't kill an in-flight turn.
                  Background-stream state surfaces in-context on the chat tab
                  (issue #286, Lume §7.4/§7.6), not in a floating toast. */}
              <StreamRunner />
              {/* Headless — mirrors the browser's IANA zone into a cookie so
                  the RSC request config renders timestamps in the operator's
                  zone rather than the container's (issue #1091). */}
              <TimeZoneSync />
              <SessionWatcher />
              <RuntimeReadinessBanner />
              {/* Headless — tells the desktop shell the UI language so its
                  own dialogs follow it, not the OS (issue #1074).
                  ORDER IS LOAD-BEARING: this must stay BEFORE
                  <DesktopUiReady />. Sibling effects run in tree order and
                  Electron keeps IPC send order, so mounting it first puts
                  `omadia:uiLocale` ahead of `omadia:uiReady`. The ready ping
                  releases the recovery-key reminder, which translates its
                  text synchronously; arriving second, the locale would come
                  too late and the reminder would speak the OS language.
                  Pinned by DesktopLocaleSync.test.tsx. */}
              <DesktopLocaleSync />
              <DesktopUiReady />
            </StreamStoreProvider>
          </ChatSessionsProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
