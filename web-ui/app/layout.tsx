import type { Metadata } from 'next';
import Link from 'next/link';
import { Geist, Geist_Mono, Source_Serif_4 } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

import { AuthBadge } from './_components/AuthBadge';
import { CreateIssueButton } from './_components/CreateIssueButton';
import { LocaleSwitcher } from './_components/LocaleSwitcher';
import { Nav } from './_components/Nav';
import { ThemeControls } from './_components/ThemeControls';
import { SessionWatcher } from './_components/SessionWatcher';
import { StreamRunner } from './_components/StreamRunner';
import { StreamToasts } from './_components/StreamToasts';
import { ChatSessionsProvider } from './_lib/chatSessionsContext';
import { StreamStoreProvider } from './_lib/streamStore';
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

/* Pre-hydration palette/theme application — sets data-palette + data-theme on
   <html> from localStorage before first paint so there is no flash of the
   default palette/mode. Mirrors the keys ThemeControls writes. */
const THEME_BOOTSTRAP = `(function(){try{var d=document.documentElement;var p=localStorage.getItem('omadia-palette');d.setAttribute('data-palette',(p==='petrol'||p==='atelier'||p==='lagoon')?p:'lagoon');var t=localStorage.getItem('omadia-theme');if(t==='light'||t==='dark')d.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-palette','lagoon');}})();`;

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
  return (
    <html
      lang={locale}
      className={`${sans.variable} ${serif.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex h-full flex-col">
        <script
          // Runs before paint; sets palette/mode from localStorage (no FOUC).
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }}
        />
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
                      <span className="font-display text-lg text-[color:var(--fg-strong)]">
                        Omadia
                      </span>
                      <span className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
                        an Agentic OS
                      </span>
                    </span>
                  </Link>
                  <span className="text-xs text-[color:var(--fg-muted)]">
                    {t('subtitle')}
                  </span>
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
              {/* Background-stream toasts (only render for chats that
                  aren't currently in view). The runner is headless — it
                  owns the fetch + NDJSON-parse loop so that switching to
                  another menu route doesn't kill an in-flight turn. */}
              <StreamRunner />
              <StreamToasts />
              <SessionWatcher />
            </StreamStoreProvider>
          </ChatSessionsProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
