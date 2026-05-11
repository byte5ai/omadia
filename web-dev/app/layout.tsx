import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Days_One,
  JetBrains_Mono,
  Nunito_Sans,
} from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

import { AuthBadge } from './_components/AuthBadge';
import { LocaleSwitcher } from './_components/LocaleSwitcher';
import { Nav } from './_components/Nav';
import './globals.css';

/**
 * Typography per byte5 Design System:
 *   - Days One (single weight) for display + logo only.
 *   - Nunito Sans as the web fallback for Avenir Next — body + UI.
 *   - JetBrains Mono for IDs / versions / entity URIs.
 *
 * The CSS variable names (--font-serif, --font-sans, --font-mono) are kept
 * for continuity with the first UI slice, even though the actual faces are
 * now Days One / Nunito Sans / JetBrains Mono. The compat aliases in
 * theme.css map the byte5-native names (--font-display, --font-text) onto
 * the same stacks.
 */
const display = Days_One({
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
  weight: '400',
});

const text = Nunito_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '600', '700', '900'],
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

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
      className={`${display.variable} ${text.variable} ${mono.variable}`}
    >
      <body className="flex h-full flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <header className="border-b border-[color:var(--border)] bg-[color:var(--bg)]/90 px-6 py-3 backdrop-blur">
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
                <span className="text-[color:var(--highlight)] font-[900]">
                  :
                </span>{' '}
                {t('subtitle')}
              </span>
              <div className="ml-auto flex items-center gap-5">
                <Nav />
                <span
                  className="hidden h-5 w-px bg-[color:var(--border)] sm:block"
                  aria-hidden
                />
                <LocaleSwitcher />
                <AuthBadge />
              </div>
            </div>
          </header>
          <div className="min-h-0 flex-1">{children}</div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
