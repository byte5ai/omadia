import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * Issue #1398 — omadia's own 404, for unknown routes and every page that calls
 * `notFound()`. Without it Next.js fell back to its built-in page: always
 * English, no way back into the app, and inline styles that set
 * `body{background:#000}` under a dark color scheme and overrode the theme.
 * Rendered inside the root layout, so the header, nav and theme stay.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('notFound');
  return { title: t('metaTitle') };
}

export default async function NotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('notFound');
  return (
    <main className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4">
        <p className="font-mono text-sm text-[color:var(--fg-muted)]">404</p>
        <h1 className="font-display text-2xl text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="text-sm text-[color:var(--fg-muted)]">{t('description')}</p>
        <Link
          href="/"
          className="mt-2 text-sm text-[color:var(--accent)] hover:underline"
        >
          {t('backToDashboard')}
        </Link>
      </div>
    </main>
  );
}
