import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import {
  listOperatorChannels,
  type ChannelsListDto,
} from '../../_lib/channels';
import { ChannelsDashboard } from './_components/ChannelsDashboard';

/**
 * Phase B+ — operator-facing channels dashboard.
 *
 * Inverts the per-Agent bindings editor: instead of "Agent X attaches
 * these keys", show "these keys exist on the platform; here's who handles
 * each". Read side is built from each channel-kind plugin's
 * `ChannelKeyDirectory` contribution.
 */

export const metadata: Metadata = {
  title: 'Channels · Omadia',
};

export const dynamic = 'force-dynamic';

export default async function OperatorChannelsPage(): Promise<React.ReactElement> {
  const t = await getTranslations('operatorChannels');
  let initial: ChannelsListDto | null = null;
  let loadError: string | null = null;
  try {
    initial = await listOperatorChannels();
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError = err instanceof Error ? err.message : t('loadError');
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
        <ChannelsDashboard initial={initial!} />
      )}
    </main>
  );
}
