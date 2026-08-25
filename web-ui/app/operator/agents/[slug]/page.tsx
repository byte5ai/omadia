import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../../_lib/authRedirect';
import {
  FALLBACK_AGENT_SLUG,
  listOperatorAgents,
  type OperatorAgentsListDto,
} from '../../../_lib/agents';
import { AgentDetail } from './_components/AgentDetail';

/**
 * Issue #861 — per-agent capability page (epic #860).
 *
 * One orchestrator, one page: the multi-bot Teams identities give every
 * agent its own capability set, and editing that set inside the dashboard's
 * expandable cards stops scaling once tool grants and MCP assignments join
 * plugins. This route hosts the per-agent surfaces; the wiring unit links it
 * from the dashboard and mounts the sibling grant/MCP components here.
 *
 * Data flow mirrors `../page.tsx`: the RSC fetches the full agents list (an
 * endpoint every deployed middleware already serves) and hands the matching
 * agent to the client component; writes go through the same-origin
 * `/bot-api` proxy and `router.refresh()` re-runs this fetch.
 */

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: RouteParams): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations('operatorAgents');
  return { title: t('detailMetaTitle', { slug: decodeURIComponent(slug) }) };
}

export default async function OperatorAgentDetailPage({
  params,
}: RouteParams): Promise<React.ReactElement> {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const t = await getTranslations('operatorAgents');

  let list: OperatorAgentsListDto | null = null;
  let loadError: string | null = null;
  try {
    list = await listOperatorAgents();
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError = err instanceof Error ? err.message : t('loadError');
  }

  const agent = list?.agents.find((a) => a.slug === slug) ?? null;
  if (list && !agent) notFound();

  return (
    <main className="mx-auto w-full max-w-[1100px] px-6 py-12 lg:px-8 lg:py-16">
      <Link
        href="/operator/agents"
        className="text-sm text-[color:var(--accent)] hover:underline"
      >
        ← {t('detailBackToList')}
      </Link>
      {!agent || !list ? (
        <div className="mt-6 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {loadError ?? t('loadError')}
        </div>
      ) : (
        <>
          <header className="mb-8 mt-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {agent.name}{' '}
              <span className="font-mono text-lg text-[color:var(--fg-muted)]">
                ({agent.slug})
              </span>
            </h1>
            <p className="mt-2 text-xs text-[color:var(--fg-muted)]">
              {t('agentMeta', {
                id: agent.id,
                privacy: agent.privacy_profile,
                status:
                  agent.status === 'enabled'
                    ? t('statusEnabled')
                    : t('statusDisabled'),
                runtime: agent.active
                  ? t('runtimeActive')
                  : t('runtimeInactive'),
              })}
            </p>
          </header>
          <AgentDetail
            agent={agent}
            isFallback={
              agent.slug === FALLBACK_AGENT_SLUG ||
              agent.id === list.fallback_agent_id
            }
          />
        </>
      )}
    </main>
  );
}
