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
  ApiError,
  getCliBackends,
  getEmbeddingProviderStatus,
  getLastTurn,
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

  const [provP, plugP, agentP, mcpP, cliP, embP, turnP] = await Promise.allSettled([
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
    // OM-100b — the runtime question none of the other cards asks: did the
    // last turn come back?
    getLastTurn(),
  ]);

  // 401 anywhere → re-login (redirect throws and escapes before render).
  for (const r of [provP, plugP, agentP, mcpP, cliP, embP, turnP]) {
    if (r.status === 'rejected') await redirectIfUnauthorized(r.reason);
  }

  const providers = provP.status === 'fulfilled' ? provP.value : null;
  const plugins = plugP.status === 'fulfilled' ? plugP.value : null;
  const agents = agentP.status === 'fulfilled' ? agentP.value : null;
  const mcp = mcpP.status === 'fulfilled' ? mcpP.value : null;
  const embeddings = embP.status === 'fulfilled' ? embP.value : null;
  const lastTurn = turnP.status === 'fulfilled' ? turnP.value.lastTurn : null;
  const lastTurnFailed = lastTurn?.status === 'failed';
  // OM-100b — a failed last turn is evidence ABOUT the two cards above it, not
  // only a card of its own: the credential is present and the agent exists,
  // and neither fact survived contact with a real turn. Both drop to "needs
  // attention" so the panel stops reading all-green while chat is dead.
  const turnTone: Tone = lastTurnFailed ? 'warn' : 'ok';
  const cliLoggedIn =
    cliP.status === 'fulfilled'
      ? cliP.value.backends.some((b) => b.loggedIn === 'yes')
      : false;
  // OM-78 (#1001) — the ONE readiness signal this page and the
  // RuntimeReadinessBanner share: `/operator/agents` answered, or failed with
  // anything OTHER than its structured 503. Only the 503 means "runtime down";
  // a transient 500 or a network blip must not un-tick step 1.
  const runtimeUp =
    agentP.status === 'fulfilled' ||
    !(agentP.reason instanceof ApiError && agentP.reason.status === 503);

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
  // OM-74 (#999) — what KIND of provider the orchestrator is assigned to, and
  // whether its credential was actually proved. A keyless subscription CLI
  // (`toolLess`, or the built-in `claude-cli` id) and an OAuth subscription
  // (`oauthConnect`) have no key to describe as "verified"; a key-based
  // provider earns that sentence only with `status === 'verified'`.
  const assignedProvider = providers?.providers.find(
    (p) => p.id === activeAssignment?.provider,
  );
  const assignedProviderKind: 'cli' | 'oauth' | 'api' | null =
    assignedProvider === undefined
      ? null
      : assignedProvider.toolLess === true || assignedProvider.id === 'claude-cli'
        ? 'cli'
        : assignedProvider.oauthConnect === true
          ? 'oauth'
          : 'api';
  const assignedProviderStatus = assignedProvider?.status ?? null;
  const assignedProviderLabel = assignedProvider?.label ?? null;
  // OM-84 (#1003) — only claim "off" when the status route actually said so.
  const embeddingsOff = embeddings !== null && !embeddings.capabilityPublished;
  // OM-102 — the LLM-backed half of the memory card. `undefined` means a
  // middleware older than OM-102 answered: say nothing rather than guess, so
  // an upgrade-lagging deployment does not sprout a permanent warning.
  const memoryFeatures = embeddings?.memoryFeatures ?? null;
  const memoryFeaturesOff =
    memoryFeatures === null
      ? []
      : (['factExtractor', 'topicDetector', 'scratchReaper'] as const).filter(
          (feature) => memoryFeatures[feature] === 'disabled',
        );
  // Only a MISSING LLM PROVIDER degrades the tile. The reaper is legitimately
  // off on every in-memory-KG install and whenever the operator switched it
  // off — turning those into a standing warning would just swap OM-84's false
  // OK for a false WARN, which is the same disease.
  const memoryFeaturesDegraded = memoryFeaturesOff.some(
    (feature) => memoryFeatures?.reasons?.[feature] === 'no_llm_provider',
  );
  const memoryFeaturesDetail: string | null =
    memoryFeatures === null
      ? null
      : memoryFeaturesOff.length === 0
        ? memoryFeatures.providerId === undefined
          ? t('health.embeddings.memory.allActive')
          : t('health.embeddings.memory.allActiveWithProvider', {
              provider: memoryFeatures.providerId,
            })
        : t('health.embeddings.memory.off', {
            features: memoryFeaturesOff
              .map((feature) =>
                t('health.embeddings.memory.featureWithReason', {
                  feature: t(`health.embeddings.memory.feature.${feature}`),
                  reason: t(
                    `health.embeddings.memory.reason.${
                      memoryFeatures.reasons?.[feature] ?? 'unknown'
                    }`,
                  ),
                }),
              )
              .join(', '),
          });
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

  // OM-100b — one line per error class. `cli_incompatible` gets the version
  // numbers because the remedy (update the CLI) is only actionable with them;
  // everything else falls back to the error's own first line, which is more
  // useful than a generic "something failed".
  const lastTurnDetail =
    lastTurn === null
      ? t('health.lastTurn.none')
      : lastTurn.status === 'ok'
        ? t('health.lastTurn.ok')
        : lastTurn.errorCode === 'cli_incompatible'
          ? t('health.lastTurn.cliIncompatible', {
              installed: lastTurn.cliVersion ?? t('health.lastTurn.unknownVersion'),
              required: lastTurn.minCliVersion ?? '',
            })
          : lastTurn.errorCode === 'cli_timeout'
            ? t('health.lastTurn.cliTimeout')
            : t('health.lastTurn.failure', {
                message: lastTurn.errorMessage ?? '',
              });

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
      tone: !middlewareOk ? 'down' : lastTurnFailed ? 'warn' : llmTone,
      status:
        llmTone === 'ok' && !lastTurnFailed ? t('health.ok') : t('health.warn'),
      detail: llmDetail,
      href: '/admin/providers',
      manage: t('health.manage'),
    },
    {
      title: t('health.orchestrators.title'),
      tone:
        !middlewareOk
          ? 'down'
          : orchestratorCount > 0 && !lastTurnFailed
            ? 'ok'
            : 'warn',
      status:
        orchestratorCount > 0 && !lastTurnFailed ? t('health.ok') : t('health.warn'),
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
      //
      // OM-102 — embeddings are only HALF the card's subject. Fact extraction,
      // topic detection and the scratch reaper hang off the extras plugin's
      // LLM provider instead, and on an abo-only install all three were off
      // while this tile still read a confident "OK".
      title: t('health.embeddings.title'),
      tone: !middlewareOk
        ? 'down'
        : embeddings === null
          ? 'neutral'
          : embeddings.capabilityPublished && !memoryFeaturesDegraded
            ? 'ok'
            : 'warn',
      status:
        embeddings !== null &&
        embeddings.capabilityPublished &&
        !memoryFeaturesDegraded
          ? t('health.ok')
          : t('health.warn'),
      detail:
        embeddings === null
          ? t('health.embeddings.unknown')
          : [
              embeddings.capabilityPublished
                ? t('health.embeddings.active', {
                    model:
                      embeddings.activeModel?.modelId ??
                      embeddings.activeProviderId ??
                      '',
                  })
                : t('health.embeddings.none'),
              memoryFeaturesDetail,
            ]
              .filter((part): part is string => part !== null)
              .join(' · '),
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
    {
      // OM-100b — the runtime card. `null` stays neutral on purpose: "no turn
      // has run yet" is genuinely unknown, and a green tick there would be the
      // same false comfort this card exists to remove.
      title: t('health.lastTurn.title'),
      tone: !middlewareOk ? 'down' : lastTurn === null ? 'neutral' : turnTone,
      status:
        lastTurn === null
          ? t('health.lastTurn.unknownStatus')
          : lastTurnFailed
            ? t('health.warn')
            : t('health.lastTurn.okStatus'),
      detail: lastTurnDetail,
      // A timeout is fixed on the subscription tab (the turn budget lives
      // there); everything else starts at the provider list.
      href:
        lastTurn?.errorCode === 'cli_timeout'
          ? '/admin/providers?tab=subscriptions'
          : '/admin/providers',
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
          assignedProviderStatus={assignedProviderStatus}
          assignedProviderLabel={assignedProviderLabel}
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
