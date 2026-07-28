import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { getVaultStatus } from '../_lib/api';
import { redirectIfUnauthorized } from '../_lib/authRedirect';
import { VaultStatusCard } from './_components/VaultStatusCard';

export const metadata: Metadata = {
  title: 'System · omadia',
};

export const dynamic = 'force-dynamic';

export default async function SystemPage(): Promise<React.ReactElement> {
  const t = await getTranslations('system.page');
  let status = null;
  let loadError: string | null = null;
  try {
    status = await getVaultStatus();
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError = err instanceof Error ? err.message : t('errorUnknownLoad');
  }

  return (
    <main className="mx-auto max-w-[1280px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="b5-hero-bg relative -mx-6 rounded-lg border border-[color:var(--divider)] px-6 py-8 lg:-mx-8 lg:px-8 lg:py-12">
        <div className="flex items-baseline gap-3 text-[12px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
          <span className="font-mono-num text-[color:var(--fg-subtle)]">
            03
          </span>
          <span className="h-px flex-1 bg-[color:var(--border)]" />
          <span>System</span>
        </div>

        <h1 className="font-display mt-6 text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>

        <p className="mt-6 max-w-2xl text-[18px] font-semibold leading-[1.55] text-[color:var(--fg-muted)]">
          <span className="text-[color:var(--highlight)] font-[900]">:</span>{' '}
          {t('intro')}
        </p>
      </header>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        {loadError ? (
          <div className="rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/5 p-6 text-sm text-[color:var(--danger)]">
            <div className="font-semibold">{t('loadErrorTitle')}</div>
            <div className="mt-2 font-mono text-xs">{loadError}</div>
          </div>
        ) : status ? (
          <VaultStatusCard status={status} />
        ) : null}
      </section>
    </main>
  );
}
