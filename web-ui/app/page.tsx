import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  ArrowUpRight,
  Boxes,
  MessageSquare,
  RefreshCw,
  Settings,
  Store,
} from 'lucide-react';

import { getProviders, listStorePlugins } from './_lib/api';
import { listOperatorAgents } from './_lib/agents';
import { redirectIfUnauthorized } from './_lib/authRedirect';
import { cn } from './_lib/cn';
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

  const [provP, plugP, agentP] = await Promise.allSettled([
    getProviders(),
    listStorePlugins(),
    listOperatorAgents(),
  ]);

  // 401 anywhere → re-login (redirect throws and escapes before render).
  for (const r of [provP, plugP, agentP]) {
    if (r.status === 'rejected') await redirectIfUnauthorized(r.reason);
  }

  const providers = provP.status === 'fulfilled' ? provP.value : null;
  const plugins = plugP.status === 'fulfilled' ? plugP.value : null;
  const agents = agentP.status === 'fulfilled' ? agentP.value : null;

  // Middleware is "connected" if any call came back at all — a transport
  // failure rejects every call with the same network error.
  const middlewareOk = providers !== null || plugins !== null || agents !== null;

  const connected = providers?.providers.filter((p) => p.connected) ?? [];
  const llmOk = connected.length > 0;
  const activeAssignment =
    providers?.assignments.find((a) => a.installed) ??
    providers?.assignments[0];
  const activeLabel =
    providers?.providers.find(
      (p) => p.id === activeAssignment?.provider && p.connected,
    )?.label ??
    connected[0]?.label ??
    null;

  const orchestratorCount = agents?.agents.length ?? 0;
  const installedCount =
    plugins?.items.filter(
      (p) =>
        p.install_state === 'installed' ||
        p.install_state === 'update-available',
    ).length ?? 0;

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
      tone: !middlewareOk ? 'down' : llmOk ? 'ok' : 'warn',
      status: llmOk ? t('health.ok') : t('health.warn'),
      detail: llmOk
        ? activeLabel
          ? `${t('health.llm.connected', { count: connected.length })} · ${t('health.llm.active', { name: activeLabel })}`
          : t('health.llm.connected', { count: connected.length })
        : t('health.llm.none'),
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
      title: t('health.plugins.title'),
      tone: !middlewareOk ? 'down' : installedCount > 0 ? 'ok' : 'neutral',
      status: installedCount > 0 ? t('health.ok') : t('health.warn'),
      detail:
        installedCount > 0
          ? t('health.plugins.installed', { count: installedCount })
          : t('health.plugins.none'),
      href: '/store',
      manage: t('health.manage'),
    },
  ];

  const quick: QuickCardProps[] = [
    { href: '/chat', icon: <MessageSquare className="size-5" aria-hidden />, title: t('quick.chat.title'), description: t('quick.chat.description') },
    { href: '/store', icon: <Store className="size-5" aria-hidden />, title: t('quick.hub.title'), description: t('quick.hub.description') },
    { href: '/operator/agents', icon: <Boxes className="size-5" aria-hidden />, title: t('quick.orchestrators.title'), description: t('quick.orchestrators.description') },
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
        <DashboardOnboarding plugins={plugins?.items ?? null} llmConnected={llmOk} />

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
