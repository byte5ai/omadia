import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  ArrowUpRight,
  Boxes,
  MessageSquare,
  Plug,
  RefreshCw,
  Settings,
  Store,
} from 'lucide-react';

import {
  getCliBackends,
  getEmbeddingProviderStatus,
  getProviders,
  listStorePlugins,
} from './_lib/api';
import { getMcpServerSummary, listOperatorAgents } from './_lib/agents';
import { redirectIfUnauthorized } from './_lib/authRedirect';
import { cn } from './_lib/cn';
import { isInstalled, isReady } from './_lib/pluginCounts';
import { DashboardOnboarding } from './_components/dashboard/DashboardOnboarding';

/**
 * Operator landing surface. Replaces the chat as the first screen (chat now
 * lives at `/chat`). Three sections: a live system-health strip with deep
 * links into the matching admin surfaces, a quick-access grid, and the
 * dismissible role-onboarding wizard.
 *
 * All data is best-effort: each fetch is isolated via `allSettled` so one dead
 * endpoint degrades a single card instead of blanking the page. A 401 from any
 * call still bounces to /login (handled before deriving health).
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('dashboard');
  return { title: t('metaTitle') };
}

type Tone = 'ok' | 'warn' | 'down' | 'neutral';

export default async function DashboardPage(): Promise<React.ReactElement> {
  const t = await getTranslations('dashboard');

  const [provP, plugP, agentP, mcpP, cliP, embP] = await Promise.allSettled([
    getProviders(),
    listStorePlugins(),
    listOperatorAgents(),
    getMcpServerSummary(),
    // OM-01/12 — `loggedIn: 'yes'` is the only genuinely verified LLM signal
    // besides a probed provider key, and onboarding ignored it entirely: a user
    // logged into the Claude CLI was still told "Schritt 1: LLM verbinden".
    getCliBackends(),
    // OM-84 (#1003) — is `embeddingClient@1` published? The cheap status
    // route, not the corpus-counting page snapshot.
    getEmbeddingProviderStatus(),
  ]);

  // 401 anywhere → re-login (redirect throws and escapes before render).
  for (const r of [provP, plugP, agentP, mcpP, cliP, embP]) {
    if (r.status === 'rejected') await redirectIfUnauthorized(r.reason);
  }

  const providers = provP.status === 'fulfilled' ? provP.value : null;
  const plugins = plugP.status === 'fulfilled' ? plugP.value : null;
  const agents = agentP.status === 'fulfilled' ? agentP.value : null;
  const mcp = mcpP.status === 'fulfilled' ? mcpP.value : null;
  const embeddings = embP.status === 'fulfilled' ? embP.value : null;
  const cliLoggedIn =
    cliP.status === 'fulfilled'
      ? cliP.value.backends.some((b) => b.loggedIn === 'yes')
      : false;
  // OM-78 (#1001) — the ONE readiness signal this page and the
  // RuntimeReadinessBanner share: `/operator/agents` answered instead of
  // 503ing. Everything that claims "LLM connected" reads this.
  const runtimeUp = agents !== null;

  // Middleware is "connected" if any call came back at all — a transport
  // failure rejects every call with the same network error.
  const middlewareOk = providers !== null || plugins !== null || agents !== null;

  // OM-02/03/04: this tile used to read "VERBUNDEN · Aktiv: Anthropic" purely
  // because a non-empty string sat in the vault — while every chat request
  // failed with `invalid x-api-key`. "OK" now requires a provider whose key was
  // actually probed successfully; a merely-stored key reads as a warning.
  // (`connected` — "a key is on file" — deliberately has no consumer left on
  // this page. Every surface here now reads `status`; see OM-01/12 below.)
  const verified = providers?.providers.filter((p) => p.status === 'verified') ?? [];
  const unverified =
    providers?.providers.filter((p) => p.status === 'unverified') ?? [];
  const rejected = providers?.providers.filter((p) => p.status === 'invalid') ?? [];
  const llmOk = verified.length > 0;
  const activeAssignment =
    providers?.assignments.find((a) => a.installed) ??
    providers?.assignments[0];
  const activeLabel =
    providers?.providers.find(
      (p) => p.id === activeAssignment?.provider && p.status === 'verified',
    )?.label ??
    verified[0]?.label ??
    null;
  // OM-74 (#999) — what KIND of provider the orchestrator is assigned to. A
  // keyless subscription CLI (`toolLess`, or the built-in `claude-cli` id)
  // must not be described as "its key was verified".
  const assignedProvider = providers?.providers.find(
    (p) => p.id === activeAssignment?.provider,
  );
  const assignedProviderKind: 'cli' | 'api' | null =
    assignedProvider === undefined
      ? null
      : assignedProvider.toolLess === true || assignedProvider.id === 'claude-cli'
        ? 'cli'
        : 'api';
  // OM-84 (#1003) — only claim "off" when the status route actually said so.
  const embeddingsOff = embeddings !== null && !embeddings.capabilityPublished;
  // A rejected key is the most actionable signal, so it wins the detail line.
  const llmDetail = ((): string => {
    if (rejected.length > 0) return t('health.llm.invalid');
    if (llmOk) {
      const head = t('health.llm.connected', { count: verified.length });
      const withActive = activeLabel
        ? `${head} · ${t('health.llm.active', { name: activeLabel })}`
        : head;
      return unverified.length > 0
        ? `${withActive} · ${t('health.llm.unverified', { count: unverified.length })}`
        : withActive;
    }
    if (unverified.length > 0) {
      return t('health.llm.unverified', { count: unverified.length });
    }
    return t('health.llm.none');
  })();
  // Any stored-but-unproven or rejected key degrades the tile to "warn" even
  // when another provider verified — the operator needs to know.
  const llmTone =
    llmOk && rejected.length === 0 && unverified.length === 0 ? 'ok' : 'warn';

  const orchestratorCount = agents?.agents.length ?? 0;
  // OM-27 — one shared predicate for every plugin count in the app. This tile
  // and the store's "Installiert" tab used to disagree because each carried its
  // own inline filter (the store's omitted `update-available`).
  const installedPlugins = (plugins?.items ?? []).filter(isInstalled);
  const installedCount = installedPlugins.length;
  const readyCount = installedPlugins.filter(isReady).length;

  const cards: HealthCardProps[] = [
    {
      title: t('health.middleware.title'),
      tone: middlewareOk ? 'ok' : 'down',
      status: middlewareOk ? t('health.ok') : t('health.down'),
      detail: middlewareOk
        ? t('health.middleware.okDetail')
        : t('health.middleware.downDetail'),
      href: '/admin/settings',
      manage: t('health.manage'),
    },
    {
      title: t('health.llm.title'),
      tone: !middlewareOk ? 'down' : llmTone,
      status: llmTone === 'ok' ? t('health.ok') : t('health.warn'),
      detail: llmDetail,
      href: '/admin/providers',
      manage: t('health.manage'),
    },
    {
      title: t('health.orchestrators.title'),
      tone: !middlewareOk ? 'down' : orchestratorCount > 0 ? 'ok' : 'warn',
      status: orchestratorCount > 0 ? t('health.ok') : t('health.warn'),
      detail:
        orchestratorCount > 0
          ? t('health.orchestrators.available', { count: orchestratorCount })
          : t('health.orchestrators.none'),
      href: '/operator/agents',
      manage: t('health.manage'),
    },
    {
      // OM-84 (#1003) — memory, semantic search and dedup all hang off
      // `embeddingClient@1`. A default install has none, and until now no
      // surface said so: the tester learned it from an agent failing mid-answer.
      title: t('health.embeddings.title'),
      tone: !middlewareOk
        ? 'down'
        : embeddings === null
          ? 'neutral'
          : embeddings.capabilityPublished
            ? 'ok'
            : 'warn',
      status:
        embeddings !== null && embeddings.capabilityPublished
          ? t('health.ok')
          : t('health.warn'),
      detail:
        embeddings === null
          ? t('health.embeddings.unknown')
          : embeddings.capabilityPublished
            ? t('health.embeddings.active', {
                model:
                  embeddings.activeModel?.modelId ??
                  embeddings.activeProviderId ??
                  '',
              })
            : t('health.embeddings.none'),
      href: '/admin/embedding-provider',
      manage: t('health.manage'),
    },
    {
      title: t('health.plugins.title'),
      tone: !middlewareOk
        ? 'down'
        : installedCount === 0
          ? 'neutral'
          : readyCount < installedCount
            ? 'warn'
            : 'ok',
      status:
        installedCount > 0 && readyCount === installedCount
          ? t('health.ok')
          : t('health.warn'),
      // OM-16/OM-27 — "installed" alone hid the OM-16 failure mode: a plugin
      // present in the registry with every credential emptied. Report the
      // readiness split whenever it differs from the raw install count.
      detail:
        installedCount === 0
          ? t('health.plugins.none')
          : readyCount < installedCount
            ? `${t('health.plugins.installed', { count: installedCount })} · ${t(
                'health.plugins.ready',
                { n: readyCount, total: installedCount },
              )}`
            : t('health.plugins.installed', { count: installedCount }),
      href: '/store',
      manage: t('health.manage'),
    },
    {
      title: t('health.mcp.title'),
      tone: !middlewareOk
        ? 'down'
        : mcp && mcp.total > 0
          ? mcp.enabled > 0
            ? 'ok'
            : 'warn'
          : 'neutral',
      status: mcp && mcp.enabled > 0 ? t('health.ok') : t('health.warn'),
      detail:
        mcp && mcp.total > 0
          ? mcp.needsDiscovery > 0
            ? t('health.mcp.summaryPending', {
                enabled: mcp.enabled,
                total: mcp.total,
                tools: mcp.tools,
                pending: mcp.needsDiscovery,
              })
            : t('health.mcp.summary', {
                enabled: mcp.enabled,
                total: mcp.total,
                tools: mcp.tools,
              })
          : t('health.mcp.none'),
      href: '/admin/mcp',
      manage: t('health.manage'),
    },
  ];

  const quick: QuickCardProps[] = [
    { href: '/chat', icon: <MessageSquare className="size-5" aria-hidden />, title: t('quick.chat.title'), description: t('quick.chat.description') },
    { href: '/store', icon: <Store className="size-5" aria-hidden />, title: t('quick.hub.title'), description: t('quick.hub.description') },
    { href: '/operator/agents', icon: <Boxes className="size-5" aria-hidden />, title: t('quick.orchestrators.title'), description: t('quick.orchestrators.description') },
    { href: '/admin/mcp', icon: <Plug className="size-5" aria-hidden />, title: t('quick.mcp.title'), description: t('quick.mcp.description') },
    { href: '/routines', icon: <RefreshCw className="size-5" aria-hidden />, title: t('quick.routines.title'), description: t('quick.routines.description') },
    { href: '/admin', icon: <Settings className="size-5" aria-hidden />, title: t('quick.admin.title'), description: t('quick.admin.description') },
  ];

  return (
    <main className="mx-auto w-full max-w-[1280px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-10">
        <h1 className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('h1')}
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('subtitle')}
        </p>
      </header>

      <div className="flex flex-col gap-12">
        {/* OM-01/12 (Wave 5) — this deliberately switched FROM the looser "a
            key is on file" test TO `verified`. Wave 1 left the loose test in
            place so this wave could decide the semantics, and the decision is:
            a step may only be ticked on a signal that was actually proved. The
            loose test is the same one that rendered "VERBUNDEN" while every
            request failed with `invalid x-api-key`; promoting that lie into a
            checked-off step would make it more authoritative, not less.
            The offline/air-gapped case is covered by `cliLoggedIn` — a locally
            authenticated subscription CLI needs no network probe. */}
        <DashboardOnboarding
          plugins={plugins?.items ?? null}
          llmVerified={verified.length > 0}
          cliLoggedIn={cliLoggedIn}
          runtimeUp={runtimeUp}
          assignedProviderKind={assignedProviderKind}
          embeddingsOff={embeddingsOff}
          hasInstalledPlugin={installedCount > 0}
        />

        <section aria-labelledby="dash-quick-heading">
          <SectionHead
            id="dash-quick-heading"
            heading={t('quick.heading')}
            subtitle={t('quick.subtitle')}
          />
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {quick.map((q) => (
              <QuickCard key={q.href} {...q} />
            ))}
          </ul>
        </section>

        <section aria-labelledby="dash-health-heading">
          <SectionHead
            id="dash-health-heading"
            heading={t('health.heading')}
            subtitle={t('health.subtitle')}
          />
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {cards.map((c) => (
              <HealthCard key={c.title} {...c} />
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}

function SectionHead({
  id,
  heading,
  subtitle,
}: {
  id: string;
  heading: string;
  subtitle: string;
}): React.ReactElement {
  return (
    <div>
      <h2
        id={id}
        className="text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]"
      >
        {heading}
      </h2>
      <p className="mt-1 text-sm text-[color:var(--fg-subtle)]">{subtitle}</p>
    </div>
  );
}

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-[color:var(--success)]',
  warn: 'bg-[color:var(--warning)]',
  down: 'bg-[color:var(--danger)]',
  neutral: 'bg-[color:var(--fg-subtle)]',
};

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-[color:var(--success)]',
  warn: 'text-[color:var(--warning)]',
  down: 'text-[color:var(--danger)]',
  neutral: 'text-[color:var(--fg-subtle)]',
};

interface HealthCardProps {
  title: string;
  tone: Tone;
  status: string;
  detail: string;
  href: string;
  manage: string;
}

function HealthCard({
  title,
  tone,
  status,
  detail,
  href,
  manage,
}: HealthCardProps): React.ReactElement {
  return (
    <li>
      <Link
        href={href}
        className="group flex h-full flex-col rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 transition-colors hover:border-[color:var(--accent)]"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-[color:var(--fg-strong)]">
            {title}
          </span>
          <span
            className={cn('size-2 rounded-full', TONE_DOT[tone])}
            aria-hidden
          />
        </div>
        <span
          className={cn(
            'mt-2 text-[11px] font-semibold uppercase tracking-[0.16em]',
            TONE_TEXT[tone],
          )}
        >
          {status}
        </span>
        <p className="mt-1 flex-1 text-[12px] leading-relaxed text-[color:var(--fg-muted)]">
          {detail}
        </p>
        <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)] transition-colors group-hover:text-[color:var(--accent)]">
          {manage}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </span>
      </Link>
    </li>
  );
}

interface QuickCardProps {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}

function QuickCard({
  href,
  icon,
  title,
  description,
}: QuickCardProps): React.ReactElement {
  return (
    <li>
      <Link
        href={href}
        className="group flex h-full items-start gap-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5 transition-colors hover:border-[color:var(--accent)]"
      >
        <span className="mt-0.5 text-[color:var(--accent)]">{icon}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-1 text-[15px] font-semibold text-[color:var(--fg-strong)]">
            {title}
            <ArrowUpRight
              className="size-4 text-[color:var(--fg-subtle)] transition-colors group-hover:text-[color:var(--accent)]"
              aria-hidden
            />
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-[color:var(--fg-muted)]">
            {description}
          </span>
        </span>
      </Link>
    </li>
  );
}
