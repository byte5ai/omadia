import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

import { AuthBadge } from './_components/AuthBadge';
import { CreateIssueButton } from './_components/CreateIssueButton';
import { LocaleSwitcher } from './_components/LocaleSwitcher';
import { Nav } from './_components/Nav';
import { ThemeControls } from './_components/ThemeControls';
import { SessionWatcher } from './_components/SessionWatcher';
import { RuntimeReadinessBanner } from './_components/RuntimeReadinessBanner';
import { DesktopUiReady } from './_components/DesktopUiReady';
import { StreamRunner } from './_components/StreamRunner';
import { fontVariables } from './_fonts';
import { ChatSessionsProvider } from './_lib/chatSessionsContext';
import { StreamStoreProvider } from './_lib/streamStore';
import { fetchNavEntries } from './_lib/navigation';
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
  const t = await getTranslations('layout');
  const jar = await cookies();
  // Plugin-contributed menu entries, resolved for this locale server-side so
  // the nav is correct on first paint and stays on next-intl's single i18n
  // clock. Never throws — an unauthenticated visitor or an unreachable
  // middleware yields an empty list and the static nav renders alone.
  const navEntries = await fetchNavEntries(locale);
  const { palette, theme } = parseUiPrefsCookie(jar.get(UI_PREFS_COOKIE)?.value);
  return (
    <html
      lang={locale}
      className={fontVariables}
      data-palette={palette}
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
                    <span className="flex flex-col leading-none">
                      <span className="font-logo text-lg text-[color:var(--fg-strong)]">
                        omadia
                      </span>
                      <span className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
                        {t('tagline')}
                      </span>
                    </span>
                  </Link>
                  {/* `min-w-0` + a tighter sub-xl gap: flex items default to
                      `min-width:auto`, so at the desktop shell's 1100px window
                      the logo, six uppercase nav items, the issue button, both
                      selects and the auth badge over-subscribe the row and
                      overflow instead of shrinking (OM-20/40, OM-30). */}
                  <div className="ml-auto flex min-w-0 items-center gap-2 xl:gap-4">
                    <Nav entries={navEntries} />
                    <span
                      className="hidden h-5 w-px bg-[color:var(--border)] sm:block"
                      aria-hidden
                    />
                    <CreateIssueButton />
                    <ThemeControls />
                    <LocaleSwitcher />
                    <AuthBadge />
                  </div>
                </div>
              </header>
              <div className="min-h-0 flex-1">{children}</div>
              {/* Headless stream runner — owns the fetch + NDJSON-parse loop
                  so switching menu route doesn't kill an in-flight turn.
                  Background-stream state surfaces in-context on the chat tab
                  (issue #286, Lume §7.4/§7.6), not in a floating toast. */}
              <StreamRunner />
              <SessionWatcher />
              <RuntimeReadinessBanner />
              <DesktopUiReady />
            </StreamStoreProvider>
          </ChatSessionsProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
