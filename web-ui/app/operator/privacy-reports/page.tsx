import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import { listMissReports, type MissReportDto } from '../../_lib/privacyReports';
import { MissReportList } from './_components/MissReportList';

/**
 * #760 — the privacy miss-report review queue. Reports arrive from the
 * "report a missed value" affordance on the PrivacyReceiptCard; a reviewer
 * turns a term into a `custom_terms` deny-list entry on the privacy plugin
 * and resolves the report.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('operatorPrivacyReports');
  return { title: t('metaTitle') };
}

export const dynamic = 'force-dynamic';

export default async function PrivacyReportsPage(): Promise<React.ReactElement> {
  const t = await getTranslations('operatorPrivacyReports');
  let initial: MissReportDto[] | null = null;
  let loadError: string | null = null;
  try {
    initial = (await listMissReports('open')).items;
  } catch (err) {
    await redirectIfUnauthorized(err);
    console.error('[operator/privacy-reports] initial load failed:', err);
    loadError = t('loadError');
  }

  return (
    <main className="mx-auto w-full max-w-[1100px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--fg-muted)]">
          {t('subtitle')}
        </p>
      </header>
      {loadError ? (
        <div className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {loadError}
        </div>
      ) : (
        <MissReportList initial={initial!} />
      )}
    </main>
  );
}
