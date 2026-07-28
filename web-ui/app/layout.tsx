import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Days_One, Geist, Geist_Mono, Source_Serif_4 } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

import { AuthBadge } from './_components/AuthBadge';
import { CreateIssueButton } from './_components/CreateIssueButton';
import { LocaleSwitcher } from './_components/LocaleSwitcher';
import { Nav } from './_components/Nav';
import { ThemeControls } from './_components/ThemeControls';
import { SessionWatcher } from './_components/SessionWatcher';
import { StreamRunner } from './_components/StreamRunner';
import { ChatSessionsProvider } from './_lib/chatSessionsContext';
import { StreamStoreProvider } from './_lib/streamStore';
import { UI_PREFS_COOKIE, parseUiPrefsCookie } from './_lib/uiPrefs';
import './globals.css';

/**
 * Typography per the Lume spec (§2.7) — three registers, three variable
 * families, all self-hosted by next/font (no runtime font-CDN requests):
 *   - Geist          — structural register: UI, labels, headings, buttons.
 *   - Source Serif 4 — prose register: long-form agent narration.
 *   - Geist Mono     — data/code register: IDs, numbers, code, paths.
 *
 * next/font assigns dedicated CSS variables (--font-geist, --font-source-serif,
 * --font-geist-mono); _lib/theme.css composes them into --font-sans / --font-serif
 * / --font-mono with platform-strongest fallbacks. Geist is preloaded for FCP;
 * the prose + mono faces are deferred (§2.7 "Font loading").
 */
const sans = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const serif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-source-serif',
  display: 'swap',
  preload: false,
});

const mono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  display: 'swap',
  preload: false,
});

/**
 * Brand wordmark only — the omadia logo (header + login card) keeps the
 * original Days One face. Lume headings elsewhere stay on Geist per §2.7
 * (see globals.css .font-display); this is a separate `.font-logo` class
 * so the wordmark can diverge without reopening that decision sitewide.
 */
const logo = Days_One({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-days-one',
  display: 'swap',
  preload: false,
});

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
  const { palette, theme } = parseUiPrefsCookie(jar.get(UI_PREFS_COOKIE)?.value);
  return (
    <html
      lang={locale}
      className={`${sans.variable} ${serif.variable} ${mono.variable} ${logo.variable}`}
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
                    className="flex items-center transition-opacity hover:opacity-90"
                    aria-label={t('logoAriaLabel')}
                  >
                    <span className="flex flex-col leading-none">
                      <span className="font-logo text-lg text-[color:var(--fg-strong)]">
                        omadia
                      </span>
                      <span className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
                        an Agentic OS
                      </span>
                    </span>
                  </Link>
                  <div className="ml-auto flex items-center gap-4">
                    <Nav />
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
            </StreamStoreProvider>
          </ChatSessionsProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
