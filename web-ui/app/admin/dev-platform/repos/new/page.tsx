'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { AddRepoWizard } from '../../_components/AddRepoWizard';

/**
 * Epic #470 W0 — the add-repo wizard route (UI spec §3). Its own page (not a
 * modal) because the device flow leaves for github.com.
 */
export default function NewRepoPage(): React.ReactElement {
  const t = useTranslations('adminDevPlatform.wizard');
  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-12 lg:px-8 lg:py-16">
      <div className="mb-6">
        <Link href="/admin/dev-platform?tab=repos" className="text-sm text-[color:var(--accent)] underline">
          {t('backToRepos')}
        </Link>
      </div>
      <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
        {t('title')}
      </h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">{t('intro')}</p>
      <div className="mt-8">
        <AddRepoWizard />
      </div>
    </div>
  );
}
