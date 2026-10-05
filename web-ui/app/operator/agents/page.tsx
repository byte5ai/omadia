import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import { listOperatorAgents } from '../../_lib/agents';
import { listOperatorChannels } from '../../_lib/channels';
import { runtimeUnavailableCause } from '../../_lib/runtimeReadiness';
import { AgentsDashboard } from './_components/AgentsDashboard';
import { OrchestratorSetupState } from './_components/OrchestratorSetupState';
import { ChannelsDashboard } from '../channels/_components/ChannelsDashboard';

/**
 * US9 — operator-facing multi-orchestrator dashboard.
 *
 * Hosts both settings surfaces on one page: the orchestrator registry and
 * the channel routing table. The nav links here directly (no sub-dropdown).
 *
 * On a fresh install both routes answer the middleware's structured 503
 * (`multi_orchestrator_unavailable`): no orchestrator runs yet. That is the
 * expected first-start state and renders {@link OrchestratorSetupState}.
 * Any other failure stays an error on the page, with the technical detail
 * under a catalogue message, so a real outage is never mistaken for setup.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('operatorAgents');
  return { title: t('metaTitle') };
}

export const dynamic = 'force-dynamic';

function LoadError({
  message,
  detail,
}: {
  message: string;
  detail: string | null;
}): React.ReactElement {
  return (
    <div
      role="alert"
      className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]"
    >
      <p>{message}</p>
      {detail ? <p className="mt-1 font-mono text-xs opacity-80">{detail}</p> : null}
    </div>
  );
}

function errorDetail(reason: unknown): string | null {
  return reason instanceof Error ? reason.message : null;
}

export default async function OperatorAgentsPage(): Promise<React.ReactElement> {
  const t = await getTranslations('operatorAgents');
  const tc = await getTranslations('operatorChannels');

  const [agents, channels] = await Promise.allSettled([
    listOperatorAgents(),
    listOperatorChannels(),
  ]);
  if (agents.status === 'rejected') await redirectIfUnauthorized(agents.reason);
  if (channels.status === 'rejected') await redirectIfUnauthorized(channels.reason);

  // Only the orchestrator route reports WHY the runtime is unavailable; the
  // channels route sends the marker without a cause, so it follows the
  // orchestrator verdict and never opens the setup state on its own.
  const setupCause =
    agents.status === 'rejected' ? runtimeUnavailableCause(agents.reason) : null;
  const channelsAwaitSetup =
    setupCause !== null &&
    channels.status === 'rejected' &&
    runtimeUnavailableCause(channels.reason) !== null;

  return (
    <main className="mx-auto w-full max-w-[1400px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--fg-muted)]">
          {t('subtitle')}
        </p>
      </header>
      {agents.status === 'fulfilled' ? (
        <AgentsDashboard initial={agents.value} />
      ) : setupCause !== null ? (
        <OrchestratorSetupState cause={setupCause} />
      ) : (
        <LoadError message={t('loadError')} detail={errorDetail(agents.reason)} />
      )}

      <section className="mt-16 border-t border-[color:var(--border)] pt-12">
        <header className="mb-8">
          <h2 className="text-2xl font-semibold tracking-tight">{tc('title')}</h2>
          <p className="mt-2 max-w-2xl text-sm text-[color:var(--fg-muted)]">
            {tc('subtitle')}
          </p>
        </header>
        {channels.status === 'fulfilled' ? (
          <ChannelsDashboard initial={channels.value} />
        ) : channelsAwaitSetup ? (
          <p
            data-testid="channels-await-setup"
            className="max-w-2xl text-sm text-[color:var(--fg-muted)]"
          >
            {tc('awaitingOrchestrator')}
          </p>
        ) : (
          <LoadError message={tc('loadError')} detail={errorDetail(channels.reason)} />
        )}
      </section>
    </main>
  );
}
