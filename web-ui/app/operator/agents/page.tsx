import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import {
  listOperatorAgents,
  type OperatorAgentsListDto,
} from '../../_lib/agents';
import {
  listOperatorChannels,
  type ChannelsListDto,
} from '../../_lib/channels';
import { AgentsDashboard } from './_components/AgentsDashboard';
import { ChannelsDashboard } from '../channels/_components/ChannelsDashboard';

/**
 * US9 — operator-facing multi-orchestrator dashboard.
 *
 * Hosts both settings surfaces on one page: the orchestrator registry and
 * the channel routing table. The nav links here directly (no sub-dropdown).
 */

export const metadata: Metadata = {
  title: 'Orchestrators · omadia',
};

export const dynamic = 'force-dynamic';

export default async function OperatorAgentsPage(): Promise<React.ReactElement> {
  const t = await getTranslations('operatorAgents');
  const tc = await getTranslations('operatorChannels');

  let initial: OperatorAgentsListDto | null = null;
  let loadError: string | null = null;
  try {
    initial = await listOperatorAgents();
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError = err instanceof Error ? err.message : t('loadError');
  }

  let channels: ChannelsListDto | null = null;
  let channelsError: string | null = null;
  try {
    channels = await listOperatorChannels();
  } catch (err) {
    await redirectIfUnauthorized(err);
    channelsError = err instanceof Error ? err.message : tc('loadError');
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] px-6 py-12 lg:px-8 lg:py-16">
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
        <AgentsDashboard initial={initial!} />
      )}

      <section className="mt-16 border-t border-[color:var(--border)] pt-12">
        <header className="mb-8">
          <h2 className="text-2xl font-semibold tracking-tight">{tc('title')}</h2>
          <p className="mt-2 max-w-2xl text-sm text-[color:var(--fg-muted)]">
            {tc('subtitle')}
          </p>
        </header>
        {channelsError ? (
          <div className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
            {channelsError}
          </div>
        ) : (
          <ChannelsDashboard initial={channels!} />
        )}
      </section>
    </main>
  );
}
