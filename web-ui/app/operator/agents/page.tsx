import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import {
  listOperatorAgents,
  type OperatorAgentsListDto,
} from '../../_lib/agents';
import { AgentsDashboard } from './_components/AgentsDashboard';

/**
 * US9 — operator-facing multi-orchestrator dashboard.
 */

export const metadata: Metadata = {
  title: 'Agents · Omadia',
};

export const dynamic = 'force-dynamic';

export default async function OperatorAgentsPage(): Promise<React.ReactElement> {
  const t = await getTranslations('operatorAgents');
  let initial: OperatorAgentsListDto | null = null;
  let loadError: string | null = null;
  try {
    initial = await listOperatorAgents();
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError = err instanceof Error ? err.message : t('loadError');
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-10">
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
        <AgentsDashboard initial={initial!} />
      )}
    </main>
  );
}
