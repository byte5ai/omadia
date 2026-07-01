import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import { listSkills, type SkillNode } from '../../_lib/agentBuilder';
import { SkillsDashboard } from './_components/SkillsDashboard';

export const metadata: Metadata = {
  title: 'Skills · omadia',
};

export const dynamic = 'force-dynamic';

export default async function OperatorSkillsPage(): Promise<React.ReactElement> {
  const t = await getTranslations('skills');

  let initial: SkillNode[] = [];
  let loadError: string | null = null;
  try {
    initial = (await listSkills()).skills;
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError = err instanceof Error ? err.message : t('loadError');
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--fg-muted)]">{t('subtitle')}</p>
      </header>
      {loadError ? (
        <div className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {loadError}
        </div>
      ) : (
        <SkillsDashboard initial={initial} />
      )}
    </main>
  );
}
