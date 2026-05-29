import type { Metadata } from 'next';
import Link from 'next/link';
import { HardDrive, PackageCheck, Store } from 'lucide-react';

import { listProfiles, listStorePlugins } from '../_lib/api';
import { redirectIfUnauthorized } from '../_lib/authRedirect';
import type { Plugin, PluginKind } from '../_lib/storeTypes';
import type { ProfileSummary } from '../_lib/profileTypes';
import { OnboardingModal } from '../_components/onboarding/OnboardingModal';
import { PluginCard } from '../_components/store/PluginCard';
import { UploadDropzone } from '../_components/store/UploadDropzone';
import { cn } from '../_lib/cn';

export const metadata: Metadata = {
  title: 'Plugin-Store · Omadia',
};

export const dynamic = 'force-dynamic';

type CategoryFilter = 'all' | PluginKind;

/** Top-level view switch by plugin origin: `hub` = advertised by a remote
 *  registry, `local` = local catalog package (not installed), `installed` =
 *  already in the runtime registry. */
type SourceFilter = 'hub' | 'local' | 'installed';

const FILTER_LABEL: Record<CategoryFilter, string> = {
  all: 'Alle',
  integration: 'Integrations',
  agent: 'Agents',
  channel: 'Channels',
  tool: 'Tools',
  extension: 'Extensions',
};

export default async function StorePage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; source?: string }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const source = parseSource(params.source);
  const filter = parseFilter(params.kind);

  let plugins: Plugin[] = [];
  let loadError: string | null = null;
  let profiles: ProfileSummary[] = [];

  try {
    const resp = await listStorePlugins();
    plugins = resp.items;
  } catch (err) {
    await redirectIfUnauthorized(err);
    loadError =
      err instanceof Error
        ? err.message
        : 'Unbekannter Fehler beim Laden des Katalogs.';
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
    <main className="mx-auto max-w-[1280px] px-6 py-12 lg:px-10 lg:py-16">
      <OnboardingModal installedCount={installedCount} profiles={profiles} />

      {/* Hero — Omadia brand cadence (Days One headline + magenta colon lead) */}
      <header className="b5-hero-bg relative -mx-6 rounded-[22px] border border-[color:var(--divider)] px-6 py-10 lg:-mx-10 lg:px-10 lg:py-14">
        <div className="flex items-baseline gap-3 text-[12px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent)]">
          <span className="font-mono-num text-[color:var(--fg-subtle)]">
            01
          </span>
          <span className="h-px flex-1 bg-[color:var(--border)]" />
          <span>Plugin-Store</span>
        </div>

        <h1 className="font-display mt-6 text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] text-[color:var(--fg-strong)]">
          Agenten für die Omadia-Plattform.
        </h1>

        <p className="mt-6 max-w-2xl text-[18px] font-semibold leading-[1.55] text-[color:var(--fg)]">
          <span className="b5-colon">:</span>
          Der Katalog bündelt Integrations (Credential-Container), Agents
          (Domain-Capabilities) und Channels (User-Kanäle wie Teams,
          Telegram). Ein Klick auf eine Kachel zeigt Berechtigungen, Secrets
          und Abhängigkeiten vor der Installation.
        </p>

        {/* Stats strip — installed vs. hub split + total */}
        <dl className="mt-10 grid max-w-2xl grid-cols-4 gap-6 border-t border-[color:var(--divider)] pt-5 text-sm">
          <Stat label="Plugins" value={plugins.length} />
          <Stat label="Hub" value={hubCount} accent />
          <Stat label="Lokal" value={localCount} />
          <Stat label="Installiert" value={installedCount} />
        </dl>
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
        aria-label="Kategorie filtern"
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
                  'inline-flex items-center gap-2 rounded-full px-4 py-1.5',
                  'text-[12px] font-semibold transition-colors duration-[140ms]',
                  'ease-[cubic-bezier(0.22,0.61,0.36,1)]',
                  active
                    ? 'bg-[color:var(--accent)] text-white shadow-[var(--shadow-cta)]'
                    : 'bg-[color:var(--bg-soft)] text-[color:var(--fg-muted)] hover:bg-[color:var(--gray-100)] hover:text-[color:var(--fg-strong)]',
                )}
                aria-current={active ? 'page' : undefined}
              >
                <span>{FILTER_LABEL[f]}</span>
                <span
                  className={cn(
                    'font-mono-num tabular-nums rounded-full px-1.5 text-[10px]',
                    active
                      ? 'bg-white/25 text-white'
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
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((plugin) => (
              <PluginCard key={plugin.id} plugin={plugin} />
            ))}
          </div>
        )}
      </section>

      {/* Footer note */}
      <footer className="mt-20 flex items-center justify-between border-t border-[color:var(--divider)] pt-5 text-[11px] uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
        <span>
          Quelle:{' '}
          <span className="font-mono-num normal-case tracking-normal text-[color:var(--fg-muted)]">
            docs/harness-platform/examples
          </span>
        </span>
        <span className="font-mono-num text-[color:var(--fg-muted)]">
          Omadia · v1
        </span>
      </footer>
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}): React.ReactElement {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        {label}
      </dt>
      <dd
        className={`font-display mt-1 text-[32px] leading-none ${
          accent
            ? 'text-[color:var(--highlight)]'
            : 'text-[color:var(--fg-strong)]'
        }`}
      >
        {String(value).padStart(2, '0')}
      </dd>
    </div>
  );
}

/**
 * Source switch — segmented control toggling between the installed-runtime
 * view and the Hub catalog. Server-rendered as two `<Link>`s so the active
 * view is sharable/bookmarkable via `?source=`.
 */
function SourceTabs({
  source,
  hubCount,
  localCount,
  installedCount,
}: {
  source: SourceFilter;
  hubCount: number;
  localCount: number;
  installedCount: number;
}): React.ReactElement {
  const tabs: Array<{
    key: SourceFilter;
    label: string;
    count: number;
    icon: React.ReactNode;
  }> = [
    {
      key: 'hub',
      label: 'Hub',
      count: hubCount,
      icon: <Store className="size-4" aria-hidden />,
    },
    {
      key: 'local',
      label: 'Lokal',
      count: localCount,
      icon: <HardDrive className="size-4" aria-hidden />,
    },
    {
      key: 'installed',
      label: 'Installiert',
      count: installedCount,
      icon: <PackageCheck className="size-4" aria-hidden />,
    },
  ];

  return (
    <nav
      className="mt-8 inline-flex rounded-full border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-1"
      aria-label="Quelle wählen"
    >
      {tabs.map((tab) => {
        const active = tab.key === source;
        return (
          <Link
            key={tab.key}
            href={buildHref(tab.key, 'all')}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-5 py-2',
              'text-[13px] font-semibold transition-colors duration-[140ms]',
              'ease-[cubic-bezier(0.22,0.61,0.36,1)]',
              active
                ? 'bg-[color:var(--accent)] text-white shadow-[var(--shadow-cta)]'
                : 'text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]',
            )}
          >
            {tab.icon}
            <span>{tab.label}</span>
            <span
              className={cn(
                'font-mono-num tabular-nums rounded-full px-1.5 text-[10px]',
                active
                  ? 'bg-white/25 text-white'
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

function EmptyState({
  source,
  filter,
}: {
  source: SourceFilter;
  filter: CategoryFilter;
}): React.ReactElement {
  // Kind-filtered-into-emptiness inside a non-empty source: keep it short.
  if (filter !== 'all') {
    return (
      <div className="rounded-[14px] border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
        <p className="font-display text-[22px] text-[color:var(--fg-strong)]">
          Keine {FILTER_LABEL[filter]} in dieser Ansicht.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">
          Wechsle die Kategorie oder die Quelle oben.
        </p>
      </div>
    );
  }

  if (source === 'installed') {
    return (
      <div className="rounded-[14px] border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
        <p className="font-display text-[22px] text-[color:var(--fg-strong)]">
          Noch keine Plugins installiert.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">
          Wechsle zum{' '}
          <Link
            href={buildHref('hub', 'all')}
            className="font-semibold text-[color:var(--accent)] underline-offset-4 hover:underline"
          >
            Hub
          </Link>{' '}
          oder{' '}
          <Link
            href={buildHref('local', 'all')}
            className="font-semibold text-[color:var(--accent)] underline-offset-4 hover:underline"
          >
            Lokal
          </Link>
          , um verfügbare Plugins zu durchsuchen und zu installieren.
        </p>
      </div>
    );
  }

  if (source === 'local') {
    return (
      <div className="rounded-[14px] border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
        <p className="font-display text-[22px] text-[color:var(--fg-strong)]">
          Keine lokalen Pakete.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">
          Lade ein Plugin-Paket per Drag-&-Drop oben hoch — der Server validiert
          das Manifest und registriert es im Katalog.
        </p>
      </div>
    );
  }

  // source === 'hub' and empty — no remote registry advertises an installable
  // (not-yet-local) plugin. Either no registry is reachable, or every hub
  // entry is already installed locally (the merge drops those).
  return (
    <div className="rounded-[14px] border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
      <p className="font-display text-[22px] text-[color:var(--fg-strong)]">
        Keine Plugins im Hub verfügbar.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">
        Verbinde eine Registry unter{' '}
        <Link
          href="/admin/registries"
          className="font-semibold text-[color:var(--accent)] underline-offset-4 hover:underline"
        >
          Admin · Registries
        </Link>{' '}
        — oder lade ein eigenes Paket im{' '}
        <Link
          href={buildHref('local', 'all')}
          className="font-semibold text-[color:var(--accent)] underline-offset-4 hover:underline"
        >
          Lokal
        </Link>
        -Tab hoch.
      </p>
    </div>
  );
}

function LoadErrorState({ message }: { message: string }): React.ReactElement {
  return (
    <div className="rounded-[14px] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 p-8">
      <div className="flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--danger)]">
        <span>Fehler</span>
        <span className="h-px flex-1 bg-[color:var(--danger)]/30" />
      </div>
      <p className="font-display mt-4 text-[26px] text-[color:var(--danger)]">
        Katalog konnte nicht geladen werden.
      </p>
      <p className="mt-3 font-mono-num text-sm text-[color:var(--fg-muted)]">
        {message}
      </p>
      <p className="mt-4 text-sm leading-relaxed text-[color:var(--fg-muted)]">
        Prüfe, ob die Middleware unter{' '}
        <span className="font-mono-num text-[color:var(--fg)]">
          http://localhost:3979
        </span>{' '}
        erreichbar ist und der Endpoint{' '}
        <span className="font-mono-num text-[color:var(--fg)]">
          /api/v1/store/plugins
        </span>{' '}
        antwortet.
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
