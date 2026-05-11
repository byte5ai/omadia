import type { Metadata } from 'next';
import Link from 'next/link';

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
  searchParams: Promise<{ kind?: string }>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
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

  const installedCount = plugins.filter(
    (p) => p.install_state === 'installed',
  ).length;

  const countsByKind = countByKind(plugins);
  const visible =
    filter === 'all' ? plugins : plugins.filter((p) => p.kind === filter);

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

        {/* Stats strip — three plugin kinds + total */}
        <dl className="mt-10 grid max-w-2xl grid-cols-4 gap-6 border-t border-[color:var(--divider)] pt-5 text-sm">
          <Stat label="Plugins" value={plugins.length} />
          <Stat label="Integrations" value={countsByKind.integration} />
          <Stat label="Agents" value={countsByKind.agent} />
          <Stat label="Channels" value={countsByKind.channel} />
        </dl>
      </header>

      {/* Upload dropzone — lives above the filter tabs so the "here's how to add one" path is visible before scanning the catalog. */}
      <div className="mt-8">
        <UploadDropzone />
      </div>

      {/* Category filter tabs */}
      <nav
        className="mt-10 flex flex-wrap items-center gap-2"
        aria-label="Kategorie filtern"
      >
        {(['all', 'integration', 'agent', 'channel'] as CategoryFilter[]).map(
          (f) => {
            const count =
              f === 'all' ? plugins.length : countsByKind[f as PluginKind];
            const active = f === filter;
            return (
              <Link
                key={f}
                href={f === 'all' ? '/store' : `/store?kind=${f}`}
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
          <EmptyState filter={filter} />
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((plugin, idx) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                index={idx + 1}
              />
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

function EmptyState({
  filter,
}: {
  filter: CategoryFilter;
}): React.ReactElement {
  const headline =
    filter === 'all'
      ? 'Noch keine Plugins im Katalog.'
      : `Keine ${FILTER_LABEL[filter]} installiert oder verfügbar.`;
  return (
    <div className="rounded-[14px] border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-12 text-center">
      <p className="font-display text-[22px] text-[color:var(--fg-strong)]">
        {headline}
      </p>
      <p className="mt-3 text-sm leading-relaxed text-[color:var(--fg-muted)]">
        Lege ein{' '}
        <span className="font-mono-num text-[color:var(--fg)]">
          *.manifest.yaml
        </span>{' '}
        unter{' '}
        <span className="font-mono-num text-[color:var(--fg)]">
          docs/harness-platform/examples/
        </span>{' '}
        ab und starte die Middleware neu.
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
