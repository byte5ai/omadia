import type { Metadata } from 'next';
import Link from 'next/link';
import { HardDrive, PackageCheck, Store } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { listProfiles, listStorePlugins } from '../_lib/api';
import { redirectIfUnauthorized } from '../_lib/authRedirect';
import type { Plugin, PluginKind } from '../_lib/storeTypes';
import type { ProfileSummary } from '../_lib/profileTypes';
import { OnboardingModal } from '../_components/onboarding/OnboardingModal';
import { PluginCard } from '../_components/store/PluginCard';
import { UploadDropzone } from '../_components/store/UploadDropzone';
import { cn } from '../_lib/cn';

export const metadata: Metadata = {
  title: 'Hub · omadia',
};

export const dynamic = 'force-dynamic';

type CategoryFilter = 'all' | PluginKind;

/** Top-level view switch by plugin origin: `hub` = advertised by a remote
 *  registry, `local` = local catalog package (not installed), `installed` =
 *  already in the runtime registry. */
type SourceFilter = 'hub' | 'local' | 'installed';

export default async function StorePage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; source?: string }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const source = parseSource(params.source);
  const filter = parseFilter(params.kind);
  const t = await getTranslations('store.hero');
  const tPage = await getTranslations('store.page');

  let plugins: Plugin[] = [];
  let loadError: string | null = null;
  let profiles: ProfileSummary[] = [];

  try {
    const resp = await listStorePlugins();
    plugins = resp.items;
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError =
      err instanceof Error ? err.message : tPage('unknownLoadError');
  }

  // Profiles are best-effort: a missing /v1/profiles endpoint (older
  // middleware) shouldn't break the store page. The OnboardingModal
  // renders nothing when profiles is empty.
  try {
    const resp = await listProfiles();
    profiles = resp.items;
  } catch {
    profiles = [];
  }

  // Three origins, partitioned so every plugin lands in exactly one bucket:
  //   • Hub         — advertised by a remote registry (`plugin.source` set),
  //                   available to fetch + install. An installed hub plugin
  //                   becomes local and leaves this bucket (the store router's
  //                   local-wins merge drops the remote entry on id collision).
  //   • Lokal       — local catalog packages (examples / uploaded ZIPs) that
  //                   are not yet installed.
  //   • Installiert — anything already in the runtime registry.
  const hubPlugins = plugins.filter((p) => p.source != null);
  const installedPlugins = plugins.filter(
    (p) => p.install_state === 'installed',
  );
  const localPlugins = plugins.filter(
    (p) => p.source == null && p.install_state !== 'installed',
  );
  const hubCount = hubPlugins.length;
  const localCount = localPlugins.length;
  const installedCount = installedPlugins.length;

  const scoped =
    source === 'installed'
      ? installedPlugins
      : source === 'local'
        ? localPlugins
        : hubPlugins;
  const countsByKind = countByKind(scoped);
  const visible =
    filter === 'all' ? scoped : scoped.filter((p) => p.kind === filter);

  return (
    <main className="mx-auto max-w-[1280px] px-6 py-12 lg:px-8 lg:py-16">
      <OnboardingModal installedCount={installedCount} profiles={profiles} />

      {/* Hero — omadia brand cadence (Days One headline + magenta colon lead) */}
      <header className="b5-hero-bg relative -mx-6 rounded-lg border border-[color:var(--divider)] px-6 py-8 lg:-mx-8 lg:px-8 lg:py-12">
        <div className="flex items-baseline gap-3 text-[12px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
          <span className="font-mono-num text-[color:var(--fg-subtle)]">
            01
          </span>
          <span className="h-px flex-1 bg-[color:var(--border)]" />
          <span>{t('eyebrow')}</span>
        </div>

        <h1 className="font-display mt-6 text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] text-[color:var(--fg-strong)]">
          {t('headline')}
        </h1>

        <p className="mt-6 max-w-2xl text-[18px] font-semibold leading-[1.55] text-[color:var(--fg)]">
          {t('lead')}
        </p>
      </header>

      {/* Source switch — the primary view selector by plugin origin. */}
      <SourceTabs
        source={source}
        hubCount={hubCount}
        localCount={localCount}
        installedCount={installedCount}
      />

      {/* Upload dropzone — only in the Lokal view: an uploaded ZIP becomes a
          local catalog package, which is exactly what this view lists. */}
      {source === 'local' ? (
        <div className="mt-6">
          <UploadDropzone />
        </div>
      ) : null}

      {/* Category filter tabs — scoped to the active source. */}
      <nav
        className="mt-8 flex flex-wrap items-center gap-2"
        aria-label={tPage('filterCategoryAria')}
      >
        {(['all', 'integration', 'agent', 'channel'] as CategoryFilter[]).map(
          (f) => {
            const count =
              f === 'all' ? scoped.length : countsByKind[f as PluginKind];
            const active = f === filter;
            return (
              <Link
                key={f}
                href={buildHref(source, f)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full px-4 py-2',
                  'text-[12px] font-semibold transition-colors duration-[140ms]',
                  'ease-[cubic-bezier(0.22,0.61,0.36,1)]',
                  active
                    ? 'bg-[color:var(--accent)] text-[color:var(--fg-on-dark)] shadow-[var(--shadow-cta)]'
                    : 'bg-[color:var(--bg-soft)] text-[color:var(--fg-muted)] hover:bg-[color:var(--gray-100)] hover:text-[color:var(--fg-strong)]',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <span>{tPage(`filters.${f}`)}</span>
                <span
                  className={cn(
                    'font-mono-num tabular-nums rounded-full px-2 text-[10px]',
                    active
                      ? 'text-[color:var(--accent-fg)]'
                      : 'bg-[color:var(--bg)] text-[color:var(--fg-subtle)]',
                  )}
                >
                  {count}
                </span>
              </Link>
            );
          },
        )}
      </nav>

      {/* Grid or error */}
      <section className="mt-8">
        {loadError ? (
          <LoadErrorState message={loadError} />
        ) : visible.length === 0 ? (
          <EmptyState source={source} filter={filter} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((plugin) => (
              <PluginCard key={plugin.id} plugin={plugin} />
            ))}
          </div>
        )}
      </section>

      {/* Footer note */}
      <footer className="mt-20 flex items-center justify-between border-t border-[color:var(--divider)] pt-4 text-[11px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        <span>
          {tPage('footerSource')}{' '}
          <span className="font-mono-num normal-case tracking-normal text-[color:var(--fg-muted)]">
            docs/harness-platform/examples
          </span>
        </span>
        <span className="font-mono-num text-[color:var(--fg-muted)]">
          omadia · v1
        </span>
      </footer>
    </main>
  );
}

/**
 * Source switch — segmented control toggling between the installed-runtime
 * view and the Hub catalog. Server-rendered as two `<Link>`s so the active
 * view is sharable/bookmarkable via `?source=`.
 */
async function SourceTabs({
  source,
  hubCount,
  localCount,
  installedCount,
}: {
  source: SourceFilter;
  hubCount: number;
  localCount: number;
  installedCount: number;
}): Promise<React.ReactElement> {
  const t = await getTranslations('store.page');
  const tabs: Array<{
    key: SourceFilter;
    label: string;
    count: number;
    icon: React.ReactNode;
  }> = [
    {
      key: 'hub',
      label: t('sourceHub'),
      count: hubCount,
      icon: <Store className="size-4" aria-hidden />,
    },
    {
      key: 'local',
      label: t('sourceLocal'),
      count: localCount,
      icon: <HardDrive className="size-4" aria-hidden />,
    },
    {
      key: 'installed',
      label: t('sourceInstalled'),
      count: installedCount,
      icon: <PackageCheck className="size-4" aria-hidden />,
    },
  ];

  return (
    <nav
      className="mt-8 inline-flex rounded-full border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-1"
      aria-label={t('sourceAria')}
    >
      {tabs.map((tab) => {
        const active = tab.key === source;
        return (
          <Link
            key={tab.key}
            href={buildHref(tab.key, 'all')}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-4 py-2',
              'text-[13px] font-semibold transition-colors duration-[140ms]',
              'ease-[cubic-bezier(0.22,0.61,0.36,1)]',
              active
                ? 'bg-[color:var(--accent)] text-[color:var(--fg-on-dark)] shadow-[var(--shadow-cta)]'
                : 'text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]',
            )}
          >
            {tab.icon}
            <span>{tab.label}</span>
            <span
              className={cn(
                'font-mono-num tabular-nums rounded-full px-2 text-[10px]',
                active
                  ? 'text-[color:var(--accent-fg)]'
                  : 'bg-[color:var(--bg)] text-[color:var(--fg-subtle)]',
              )}
            >
              {tab.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

async function EmptyState({
  source,
  filter,
}: {
  source: SourceFilter;
  filter: CategoryFilter;
}): Promise<React.ReactElement> {
  const t = await getTranslations('store.page');

  const link = (href: string) =>
    function EmptyStateLink(chunks: React.ReactNode): React.ReactNode {
      return (
        <Link
          href={href}
          className="font-semibold text-[color:var(--accent)] underline-offset-4 hover:underline"
        >
          {chunks}
        </Link>
      );
    };

  // Kind-filtered-into-emptiness inside a non-empty source: keep it short.
  if (filter !== 'all') {
    return (
      <div className="rounded-lg border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
        <p className="font-display text-[22px] text-[color:var(--fg-strong)]">
          {t('emptyFilteredTitle', { category: t(`filters.${filter}`) })}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">
          {t('emptyFilteredHint')}
        </p>
      </div>
    );
  }

  if (source === 'installed') {
    return (
      <div className="rounded-lg border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
        <p className="font-display text-[22px] text-[color:var(--fg-strong)]">
          {t('emptyInstalledTitle')}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">
          {t.rich('emptyInstalledBody', {
            hubLink: link(buildHref('hub', 'all')),
            localLink: link(buildHref('local', 'all')),
          })}
        </p>
      </div>
    );
  }

  if (source === 'local') {
    return (
      <div className="rounded-lg border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
        <p className="font-display text-[22px] text-[color:var(--fg-strong)]">
          {t('emptyLocalTitle')}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">
          {t('emptyLocalHint')}
        </p>
      </div>
    );
  }

  // source === 'hub' and empty — no remote registry advertises an installable
  // (not-yet-local) plugin. Either no registry is reachable, or every hub
  // entry is already installed locally (the merge drops those).
  return (
    <div className="rounded-lg border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
      <p className="font-display text-[22px] text-[color:var(--fg-strong)]">
        {t('emptyHubTitle')}
      </p>
      <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">
        {t.rich('emptyHubBody', {
          adminLink: link('/admin/registries'),
          localLink: link(buildHref('local', 'all')),
        })}
      </p>
    </div>
  );
}

async function LoadErrorState({
  message,
}: {
  message: string;
}): Promise<React.ReactElement> {
  const t = await getTranslations('store.page');
  return (
    <div className="rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 p-8">
      <div className="flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--danger)]">
        <span>{t('errorKicker')}</span>
        <span className="h-px flex-1 bg-[color:var(--danger)]/30" />
      </div>
      <p className="font-display mt-4 text-[26px] text-[color:var(--danger)]">
        {t('errorTitle')}
      </p>
      <p className="mt-3 font-mono-num text-sm text-[color:var(--fg-muted)]">
        {message}
      </p>
      <p className="mt-4 text-sm leading-relaxed text-[color:var(--fg-muted)]">
        {t.rich('errorHint', {
          host: (chunks) => (
            <span className="font-mono-num text-[color:var(--fg)]">
              {chunks}
            </span>
          ),
          endpoint: (chunks) => (
            <span className="font-mono-num text-[color:var(--fg)]">
              {chunks}
            </span>
          ),
        })}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSource(raw: string | undefined): SourceFilter {
  if (raw === 'installed') return 'installed';
  if (raw === 'local') return 'local';
  return 'hub';
}

/** Build a `/store` href preserving the source/kind pair. `hub` + `all` are
 *  the defaults, so they are omitted to keep the canonical URL clean. */
function buildHref(source: SourceFilter, kind: CategoryFilter): string {
  const params = new URLSearchParams();
  if (source !== 'hub') params.set('source', source);
  if (kind !== 'all') params.set('kind', kind);
  const qs = params.toString();
  return qs ? `/store?${qs}` : '/store';
}

function parseFilter(raw: string | undefined): CategoryFilter {
  if (
    raw === 'integration' ||
    raw === 'agent' ||
    raw === 'channel' ||
    raw === 'tool' ||
    raw === 'extension'
  ) {
    return raw;
  }
  return 'all';
}

function countByKind(plugins: Plugin[]): Record<PluginKind, number> {
  const counts: Record<PluginKind, number> = {
    agent: 0,
    integration: 0,
    channel: 0,
    tool: 0,
    extension: 0,
  };
  for (const p of plugins) counts[p.kind] += 1;
  return counts;
}
