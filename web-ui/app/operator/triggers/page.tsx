import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import { getTriggerOverview, type TriggerOverviewDto } from '../../_lib/triggers';
import { TriggerOverview } from './_components/TriggerOverview';

/**
 * #2082 — what agents do unasked (spec 2042 §5.12 "Visible"): every hook,
 * wakeup, timer, routine, schedule and batch job with purpose, deadline and
 * cost so far, the month's spend against the caps, plugin background jobs,
 * and the operator's controls (pause, resume, end).
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('operatorTriggers');
  return { title: t('metaTitle') };
}

export const dynamic = 'force-dynamic';

export default async function TriggersPage(): Promise<React.ReactElement> {
  const t = await getTranslations('operatorTriggers');
  let initial: TriggerOverviewDto | null = null;
  let loadError: string | null = null;
  try {
    initial = await getTriggerOverview();
  } catch (err) {
    await redirectIfUnauthorized(err);
    console.error('[operator/triggers] initial load failed:', err);
    loadError = t('loadError');
  }

  return (
    <main className="mx-auto w-full max-w-[1200px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--fg-muted)]">{t('subtitle')}</p>
      </header>
      {loadError || !initial ? (
        <div className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {loadError ?? t('loadError')}
        </div>
      ) : (
        <TriggerOverview initial={initial} />
      )}
    </main>
  );
}
