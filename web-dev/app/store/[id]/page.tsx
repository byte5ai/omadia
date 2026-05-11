import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  BookCheck,
  Database,
  Globe,
  KeyRound,
  Network,
  Plug,
  ShieldCheck,
} from 'lucide-react';

import { ApiError, getStorePlugin } from '../../_lib/api';
import type { Plugin, PluginSetupField } from '../../_lib/storeTypes';
import {
  AdminUiArticleSwap,
  AdminUiProvider,
  AdminUiToggle,
} from '../../_components/store/AdminUiPanel';
import { Chip } from '../../_components/store/Chip';
import { CredentialsEditor } from '../../_components/store/CredentialsEditor';
import { EditFromStoreButton } from '../../_components/store/EditFromStoreButton';
import { InstallButton } from '../../_components/store/InstallButton';
import { PluginIcon } from '../../_components/store/PluginIcon';
import { StateBadge } from '../../_components/store/StateBadge';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const detail = await getStorePlugin(decodeURIComponent(id));
    return { title: `${detail.plugin.name} · Store` };
  } catch {
    return { title: 'Plugin nicht gefunden · Store' };
  }
}

export default async function PluginDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const pluginId = decodeURIComponent(id);

  let detail;
  try {
    detail = await getStorePlugin(pluginId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const { plugin, install_available, blocking_reasons } = detail;
  const isLegacy = plugin.categories.includes('legacy');
  const visibleCategories = plugin.categories.filter((c) => c !== 'legacy');

  // S+7.7 / 2026-05-04 — admin-ui mount path. Conditional on the manifest
  // declaring `admin_ui_path` AND the plugin being installed (or having an
  // available update). The Next rewrite `/bot-api/:path*` → `/api/:path*`
  // already prepends `/api`, so we strip the leading `/api` from the
  // manifest path before prepending `/bot-api` to avoid `/api/api/…`.
  const adminUiAvailable =
    !!plugin.admin_ui_path &&
    (plugin.install_state === 'installed' ||
      plugin.install_state === 'update-available');
  const adminUiIframeSrc = adminUiAvailable
    ? `/bot-api${plugin.admin_ui_path!.replace(/^\/api(?=\/|$)/, '')}`
    : null;

  return (
    <main className="mx-auto max-w-[1280px] px-6 py-10 lg:px-10 lg:py-14">
      <Link
        href="/store"
        className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-muted)] transition hover:text-[color:var(--accent)]"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Zurück zum Katalog
      </Link>

      {/* Hero */}
      <header className="b5-hero-bg relative mt-6 -mx-6 rounded-[22px] border border-[color:var(--divider)] px-6 py-10 lg:-mx-10 lg:px-10 lg:py-12">
        <div className="flex flex-col items-start gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-start gap-6">
            <PluginIcon
              name={plugin.name}
              iconUrl={plugin.icon_url}
              size="lg"
              tone={isLegacy ? 'legacy' : 'default'}
            />
            <div className="min-w-0">
              <div className="flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-[color:var(--fg-subtle)]">
                <span className="font-mono-num">{plugin.id}</span>
              </div>
              <h1 className="font-display mt-3 text-[clamp(2.25rem,4.5vw,3.75rem)] leading-[1.05] text-[color:var(--fg-strong)]">
                {plugin.name}
              </h1>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <StateBadge
                  state={plugin.install_state}
                  isLegacy={isLegacy}
                />
                <Chip tone="mono">v{plugin.version}</Chip>
                {plugin.signed ? (
                  <Chip tone="accent">
                    <ShieldCheck className="mr-1 size-3" aria-hidden />
                    signiert
                  </Chip>
                ) : (
                  <Chip tone="muted">unsigniert</Chip>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Two-column body */}
      <AdminUiProvider>
      <div className="mt-12 grid gap-12 lg:grid-cols-[1fr_340px]">
        {/* Main content */}
        <article className="min-w-0 space-y-12">
          <AdminUiArticleSwap
            iframeSrc={adminUiIframeSrc}
            pluginName={plugin.name}
          >
          <Section label="Beschreibung" numeral="I">
            <p className="text-[18px] font-semibold leading-[1.6] text-[color:var(--fg)]">
              {plugin.description ? (
                <>
                  <span className="b5-colon">:</span>
                  {plugin.description}
                </>
              ) : (
                <span className="text-[color:var(--fg-muted)]">
                  Keine Beschreibung hinterlegt.
                </span>
              )}
            </p>
          </Section>

          {plugin.required_secrets.length > 0 ? (
            <Section
              label="Benötigte Secrets"
              numeral="II"
              meta={`${plugin.required_secrets.length} Feld${
                plugin.required_secrets.length === 1 ? '' : 'er'
              }`}
              icon={<KeyRound className="size-4" aria-hidden />}
            >
              <div className="divide-y divide-[color:var(--rule)] border-y border-[color:var(--rule)]">
                {plugin.required_secrets.map((field) => (
                  <SecretRow key={field.key} field={field} />
                ))}
              </div>
            </Section>
          ) : null}

          {/* Theme D — post-install credential editing. Visible only when
              the plugin is actually installed (otherwise there is no vault
              namespace yet). Lets the operator rotate / add / delete
              credentials AFTER install — useful for the OAuth-after-first-
              call pattern (refresh-tokens, webhook secrets returned by the
              provider post-registration). */}
          {(plugin.install_state === 'installed' ||
            plugin.install_state === 'update-available') &&
          plugin.required_secrets.length > 0 ? (
            <Section
              label="Credentials editieren"
              numeral="II.b"
              icon={<KeyRound className="size-4" aria-hidden />}
            >
              <CredentialsEditor
                pluginId={plugin.id}
                setupFields={plugin.required_secrets}
              />
            </Section>
          ) : null}

          <Section
            label="Berechtigungen"
            numeral="III"
            icon={<ShieldCheck className="size-4" aria-hidden />}
          >
            <PermissionsBlock
              perms={plugin.permissions_summary}
            />
          </Section>

          {(plugin.provides?.length ?? 0) + (plugin.requires?.length ?? 0) >
          0 ? (
            <Section
              label="Capabilities"
              numeral="IV"
              icon={<Plug className="size-4" aria-hidden />}
              meta={`${plugin.provides?.length ?? 0} liefert · ${plugin.requires?.length ?? 0} benötigt`}
            >
              <CapabilitiesBlock
                provides={plugin.provides ?? []}
                requires={plugin.requires ?? []}
              />
            </Section>
          ) : null}

          {plugin.integrations_summary.length > 0 ? (
            <Section
              label="Integrationen"
              numeral="V"
              icon={<Network className="size-4" aria-hidden />}
            >
              <ul className="space-y-2">
                {plugin.integrations_summary.map((target, idx) => (
                  <li
                    key={idx}
                    className="flex items-center gap-3 border-t border-[color:var(--rule)] py-3 first:border-t-0 first:pt-0"
                  >
                    <span className="font-mono-num text-[11px] text-[color:var(--faint-ink)]">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span className="text-[color:var(--ink)]">{target}</span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {/*
            S+7.7 — Plugin-bundled operator-admin UI iframe. Toggled by the
            sidebar `<AdminUiToggle>`. When on, `<AdminUiArticleSwap>` above
            replaces this entire `<article>` body with the iframe; when off
            it transparently passes the normal sections through.
          */}
          </AdminUiArticleSwap>
        </article>

        {/* Sidebar */}
        <aside className="space-y-8 lg:sticky lg:top-10 lg:self-start">
          <InstallButton
            pluginId={plugin.id}
            pluginName={plugin.name}
            installState={plugin.install_state}
            enabled={install_available}
            {...(blocking_reasons ? { blockingReasons: blocking_reasons } : {})}
          />

          {/* Admin-UI Toggle — sidebar control for the plugin-bundled
              operator UI. Visible whenever the plugin declares an
              admin_ui_path AND is installed (or has an update). Default
              closed; click renders the iframe section in the left column
              and scrolls it into view. */}
          {adminUiAvailable ? <AdminUiToggle /> : null}

          {/* Edit-from-Store (B.6-3) — only surfaced for installed plugins.
              Resolves to the source draft owned by the same operator;
              404 with hint if no source exists (typical: another operator
              installed it, or the source was hard-deleted). */}
          {plugin.install_state === 'installed' ? (
            <EditFromStoreButton installedAgentId={plugin.id} />
          ) : null}

          {visibleCategories.length > 0 ? (
            <div>
              <SideLabel>Kategorien</SideLabel>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {visibleCategories.map((cat) => (
                  <Chip key={cat} tone="muted">
                    {cat}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}

          <dl className="space-y-4 border-y border-[color:var(--rule)] py-5">
            <MetaRow label="Lizenz" value={plugin.license} />
            <MetaRow label="Core-Kompatibilität" value={plugin.compat_core} mono />
            <MetaRow label="Aktuelle Version" value={`v${plugin.version}`} mono />
            {plugin.version !== plugin.latest_version ? (
              <MetaRow
                label="Neueste Version"
                value={`v${plugin.latest_version}`}
                mono
              />
            ) : null}
          </dl>

          {plugin.authors.length > 0 ? (
            <div>
              <SideLabel>Autor:innen</SideLabel>
              <ul className="mt-2 space-y-1.5 text-sm">
                {plugin.authors.map((a, idx) => (
                  <li key={idx} className="text-[color:var(--ink)]">
                    {a.url ? (
                      <a
                        href={a.url}
                        rel="noopener noreferrer"
                        target="_blank"
                        className="underline decoration-[color:var(--rule-strong)] underline-offset-4 hover:decoration-[color:var(--oxblood)]"
                      >
                        {a.name}
                      </a>
                    ) : (
                      a.name
                    )}
                    {a.email ? (
                      <div className="font-mono-num text-[11px] text-[color:var(--faint-ink)]">
                        {a.email}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
      </AdminUiProvider>

      {/* Footer crumb */}
      <footer className="mt-20 flex items-center justify-between border-t border-[color:var(--rule)] pt-5 text-[11px] uppercase tracking-[0.18em] text-[color:var(--faint-ink)]">
        <span className="flex items-center gap-2">
          <BookCheck className="size-3.5" aria-hidden />
          Manifest: {isLegacy ? 'Legacy' : 'Schema v1'}
        </span>
        <span className="font-mono-num">Omadia · v1 · Slice 1.1</span>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks kept local to this page
// ---------------------------------------------------------------------------

function Section({
  label,
  numeral,
  meta,
  icon,
  children,
}: {
  label: string;
  numeral: string;
  meta?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <header className="mb-4 flex items-center gap-3 border-b border-[color:var(--divider)] pb-2">
        <span className="font-mono-num text-[12px] font-semibold text-[color:var(--accent)]">
          {numeral}
        </span>
        <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-muted)]">
          {icon}
          {label}
        </span>
        <span className="h-px flex-1 bg-[color:var(--divider)]" />
        {meta ? (
          <span className="font-mono-num text-[11px] text-[color:var(--fg-subtle)]">
            {meta}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function SecretRow({
  field,
}: {
  field: PluginSetupField;
}): React.ReactElement {
  return (
    <div className="flex items-baseline gap-4 py-3">
      <span className="font-mono-num w-48 shrink-0 text-[13px] text-[color:var(--ink)]">
        {field.key}
      </span>
      <span className="min-w-0 flex-1 text-sm text-[color:var(--muted-ink)]">
        {field.label}
      </span>
      <Chip tone={field.type === 'secret' ? 'accent' : 'muted'}>
        {field.type}
      </Chip>
    </div>
  );
}

function PermissionsBlock({
  perms,
}: {
  perms: Plugin['permissions_summary'];
}): React.ReactElement {
  const groups: Array<{
    label: string;
    icon: React.ReactNode;
    items: string[];
    mono?: boolean;
  }> = [
    {
      label: 'Memory · Reads',
      icon: <Database className="size-3.5" aria-hidden />,
      items: perms.memory_reads,
      mono: true,
    },
    {
      label: 'Memory · Writes',
      icon: <Database className="size-3.5" aria-hidden />,
      items: perms.memory_writes,
      mono: true,
    },
    {
      label: 'Graph · Reads',
      icon: <Database className="size-3.5" aria-hidden />,
      items: perms.graph_reads,
      mono: true,
    },
    {
      label: 'Graph · Writes',
      icon: <Database className="size-3.5" aria-hidden />,
      items: perms.graph_writes,
      mono: true,
    },
    {
      label: 'Netzwerk · Outbound',
      icon: <Globe className="size-3.5" aria-hidden />,
      items: perms.network_outbound,
      mono: true,
    },
  ];

  const active = groups.filter((g) => g.items.length > 0);
  if (active.length === 0) {
    return (
      <p className="text-sm italic text-[color:var(--faint-ink)]">
        Keine Berechtigungen deklariert.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {active.map((group) => (
        <div key={group.label}>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted-ink)]">
            {group.icon}
            {group.label}
          </div>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {group.items.map((item) => (
              <Chip
                key={item}
                tone={group.mono ? 'mono' : 'muted'}
                className="normal-case tracking-normal"
              >
                {item}
              </Chip>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SideLabel({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <h3 className="text-[10px] uppercase tracking-[0.22em] text-[color:var(--faint-ink)]">
      {children}
    </h3>
  );
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <dt className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--faint-ink)]">
        {label}
      </dt>
      <dd
        className={`text-[color:var(--ink)] ${
          mono ? 'font-mono-num' : 'font-display'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Capabilities-Block — S+8.5 Sub-Commit 2.
 *
 * Surface the manifest's `provides:` and `requires:` lists verbatim.
 * Status-Auflösung läuft server-side: der Install-Button ruft
 * `POST /v1/install/plugins/<id>`, die middleware antwortet mit 409
 * `install.missing_capability` + `details.available_providers` falls
 * eine Cap unaufgelöst ist, und der RequiresWizard rendert die Chain.
 * Frontend zeigt hier deshalb keine Live-Resolution — kein
 * doppeltes Walking, keine Drift gegen den Server.
 */
function CapabilitiesBlock({
  provides,
  requires,
}: {
  provides: string[];
  requires: string[];
}): React.ReactElement {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted-ink)]">
          Liefert
        </div>
        {provides.length === 0 ? (
          <p className="mt-2 text-[12px] italic text-[color:var(--faint-ink)]">
            Keine Capabilities deklariert.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {provides.map((cap) => (
              <li key={cap}>
                <Chip tone="accent" className="font-mono-num normal-case tracking-normal">
                  {cap}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted-ink)]">
          Benötigt
        </div>
        {requires.length === 0 ? (
          <p className="mt-2 text-[12px] italic text-[color:var(--faint-ink)]">
            Keine Voraussetzungen.
          </p>
        ) : (
          <>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {requires.map((cap) => (
                <li key={cap}>
                  <Chip tone="muted" className="font-mono-num normal-case tracking-normal">
                    {cap}
                  </Chip>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--faint-ink)]">
              Beim Install prüft die Middleware diese Voraussetzungen
              transitiv. Fehlt ein Provider, öffnet sich ein Wizard
              mit den passenden Plugins aus dem Katalog.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

