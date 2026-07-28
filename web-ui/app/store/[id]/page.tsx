import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  BookCheck,
  BookOpen,
  Database,
  Globe,
  KeyRound,
  Network,
  Plug,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { getLocale, getTranslations } from 'next-intl/server';

import { Markdown } from '../../_components/Markdown';
import { PluginVerdictBadge } from '../../_components/admin/PluginVerdictBadge';
import { pickLocalized } from '../../_lib/localized';

import { ApiError, getStorePlugin } from '../../_lib/api';
import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import type { Plugin, PluginSetupField } from '../../_lib/storeTypes';
import {
  AdminUiArticleSwap,
  AdminUiProvider,
  AdminUiToggle,
} from '../../_components/store/AdminUiPanel';
import { ActionStatusBanner } from '../../_components/store/ActionStatusBanner';
import { Chip } from '../../_components/store/Chip';
import { AuditModeSwitch } from '../../_components/store/AuditModeSwitch';
import { CredentialsEditor } from '../../_components/store/CredentialsEditor';
import { EditFromStoreButton } from '../../_components/store/EditFromStoreButton';
import { SelfExtensionPanel } from '../../_components/store/SelfExtensionPanel';
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
    const t = await getTranslations('store.detail');
    return { title: t('notFoundTitle') };
  }
}

export default async function PluginDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const pluginId = decodeURIComponent(id);

  // Spec 005 — the kernel OAuth broker redirects back here after consent with
  // `?connected=ok|error` (+ `&reason=` on error). Surfaced as a one-shot
  // banner; it clears on the next navigation. The ActionStatusBanner below is
  // the durable signal (the integration reports `ok` once the token + cloud_id
  // resolve).
  const sp = searchParams ? await searchParams : {};
  const connected = typeof sp['connected'] === 'string' ? sp['connected'] : undefined;
  const connectReason = typeof sp['reason'] === 'string' ? sp['reason'] : undefined;

  let detail;
  try {
    detail = await getStorePlugin(pluginId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    await redirectIfUnauthorized(err);
    throw err;
  }

  const { plugin, install_available, blocking_reasons } = detail;
  const isLegacy = plugin.categories.includes('legacy');
  const visibleCategories = plugin.categories.filter((c) => c !== 'legacy');

  // Localized setup guide — pick the active UI locale, fall back to another
  // language so a single-language guide still renders.
  const locale = await getLocale();
  const setupGuideText = pickLocalized(plugin.setup_guide, locale);
  const t = await getTranslations('store.detail');

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
    <main className="mx-auto max-w-[1280px] px-6 py-8 lg:px-8 lg:py-12">
      <Link
        href="/store"
        className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-muted)] transition hover:text-[color:var(--accent)]"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {t('backToCatalog')}
      </Link>

      {/* Hero */}
      <header className="b5-hero-bg relative mt-6 -mx-6 rounded-lg border border-[color:var(--divider)] px-6 py-8 lg:-mx-8 lg:px-8 lg:py-12">
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
                    {t('signed')}
                  </Chip>
                ) : (
                  <Chip tone="muted">{t('unsigned')}</Chip>
                )}
                {/* Issue #453 — advisory code-scan verdict for ingested
                    packages. Absent (no badge) when never scanned. */}
                {detail.verdict ? (
                  <PluginVerdictBadge severity={detail.verdict.severity} />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Spec 005 — one-shot OAuth-connect result from the broker redirect. */}
      {connected === 'ok' ? (
        <div className="mt-8 flex items-center gap-2 rounded-lg border border-[color:var(--success)]/40 bg-[color:var(--success)]/10 px-4 py-3 text-[13px] font-semibold text-[color:var(--success)]">
          <ShieldCheck className="size-4" aria-hidden />
          {t('connectedOk')}
        </div>
      ) : connected === 'error' ? (
        <div className="mt-8 rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-4 py-3 text-[13px] font-semibold text-[color:var(--danger)]">
          {connectReason
            ? t('connectedErrorWithReason', { reason: connectReason })
            : t('connectedError')}
        </div>
      ) : null}

      {/* Spec 004 — operator-action banner (auto-clears once the plugin reports
          ok, e.g. after connecting via the admin UI below). */}
      <div className="mt-8">
        <ActionStatusBanner pluginId={plugin.id} initial={plugin.action_status} />
      </div>

      {/* Two-column body */}
      <AdminUiProvider>
      <div className="mt-12 grid gap-12 lg:grid-cols-[1fr_340px]">
        {/* Main content */}
        <article className="min-w-0 space-y-12">
          <AdminUiArticleSwap
            iframeSrc={adminUiIframeSrc}
            pluginName={plugin.name}
          >
          <Section label={t('sectionDescription')} numeral="I">
            <p className="text-[18px] font-semibold leading-[1.6] text-[color:var(--fg)]">
              {plugin.description ? (
                <>
                                    {plugin.description}
                </>
              ) : (
                <span className="text-[color:var(--fg-muted)]">
                  {t('noDescription')}
                </span>
              )}
            </p>
          </Section>

          {/* Installationsanleitung — Markdown-Guide aus dem Manifest
              (`setup.guide`). Erklärt das Aufsetzen des Drittsystems: Discord-
              Bot anlegen, Microsoft-365-Credentials beschaffen, Slack-App
              registrieren, … Display-only. */}
          {setupGuideText ? (
            <Section
              label={t('sectionSetupGuide')}
              numeral="I.b"
              icon={<BookOpen className="size-4" aria-hidden />}
            >
              <Markdown source={setupGuideText} />
            </Section>
          ) : null}

          {plugin.setup_fields.length > 0 ? (
            <Section
              label={t('sectionSetupFields')}
              numeral="II"
              meta={t('setupFieldsCount', {
                count: plugin.setup_fields.length,
              })}
              icon={<KeyRound className="size-4" aria-hidden />}
            >
              <div className="divide-y divide-[color:var(--rule)] border-y border-[color:var(--rule)]">
                {plugin.setup_fields.map((field) => (
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
          plugin.setup_fields.length > 0 ? (
            <Section
              label={t('sectionEditSetupFields')}
              numeral="II.b"
              icon={<KeyRound className="size-4" aria-hidden />}
            >
              <CredentialsEditor
                pluginId={plugin.id}
                setupFields={plugin.setup_fields}
              />
            </Section>
          ) : null}

          {/* #91 — audit egress mode switch. Surfaced only for an installed
              audit/scanner plugin (one declaring permissions.network.web_scanner). */}
          {(plugin.install_state === 'installed' ||
            plugin.install_state === 'update-available') &&
          plugin.permissions_summary.network_web_scanner === true ? (
            <Section
              label={t('sectionAuditMode')}
              numeral="II.c"
              icon={<ShieldAlert className="size-4" aria-hidden />}
            >
              <AuditModeSwitch pluginId={plugin.id} />
            </Section>
          ) : null}

          {/* Plugin self-extension (operator-gated, non-escalating). Installed
              plugins only — a proposal is evaluated against the source draft's
              spec, and an approved one rebuilds + hot-reactivates the plugin.
              See docs/harness-platform/DESIGN-plugin-self-extension.md. */}
          {plugin.install_state === 'installed' ? (
            <Section
              label={t('sectionSelfExtension')}
              numeral="II.d"
              icon={<Sparkles className="size-4" aria-hidden />}
            >
              <SelfExtensionPanel agentId={plugin.id} />
            </Section>
          ) : null}

          <Section
            label={t('sectionPermissions')}
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
              label={t('sectionCapabilities')}
              numeral="IV"
              icon={<Plug className="size-4" aria-hidden />}
              meta={t('capabilitiesMeta', {
                provides: plugin.provides?.length ?? 0,
                requires: plugin.requires?.length ?? 0,
              })}
            >
              <CapabilitiesBlock
                provides={plugin.provides ?? []}
                requires={plugin.requires ?? []}
              />
            </Section>
          ) : null}

          {plugin.integrations_summary.length > 0 ? (
            <Section
              label={t('sectionIntegrations')}
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
            remote={Boolean(plugin.source)}
            installedVersion={plugin.version}
            {...(plugin.setup_guide ? { setupGuide: plugin.setup_guide } : {})}
            {...(plugin.available_version
              ? { availableVersion: plugin.available_version }
              : {})}
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
            <EditFromStoreButton publishedAgentId={plugin.id} />
          ) : null}

          {visibleCategories.length > 0 ? (
            <div>
              <SideLabel>{t('categories')}</SideLabel>
              <div className="mt-2 flex flex-wrap gap-2">
                {visibleCategories.map((cat) => (
                  <Chip key={cat} tone="muted">
                    {cat}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}

          <dl className="space-y-4 border-y border-[color:var(--rule)] py-4">
            <MetaRow label={t('license')} value={plugin.license} />
            <MetaRow label={t('coreCompat')} value={plugin.compat_core} mono />
            <MetaRow
              label={t('currentVersion')}
              value={`v${plugin.version}`}
              mono
            />
            {plugin.version !== plugin.latest_version ? (
              <MetaRow
                label={t('latestVersion')}
                value={`v${plugin.latest_version}`}
                mono
              />
            ) : null}
          </dl>

          {plugin.authors.length > 0 ? (
            <div>
              <SideLabel>{t('authors')}</SideLabel>
              <ul className="mt-2 space-y-2 text-sm">
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
      <footer className="mt-20 flex items-center justify-between border-t border-[color:var(--rule)] pt-4 text-[11px] uppercase tracking-[0.18em] text-[color:var(--faint-ink)]">
        <span className="flex items-center gap-2">
          <BookCheck className="size-3.5" aria-hidden />
          Manifest: {isLegacy ? 'Legacy' : 'Schema v1'}
        </span>
        <span className="font-mono-num">omadia · v1 · Slice 1.1</span>
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

async function PermissionsBlock({
  perms,
}: {
  perms: Plugin['permissions_summary'];
}): Promise<React.ReactElement> {
  const t = await getTranslations('store.detail.permissions');
  const groups: Array<{
    label: string;
    icon: React.ReactNode;
    items: string[];
    mono?: boolean;
  }> = [
    {
      label: t('memoryReads'),
      icon: <Database className="size-3.5" aria-hidden />,
      items: perms.memory_reads,
      mono: true,
    },
    {
      label: t('memoryWrites'),
      icon: <Database className="size-3.5" aria-hidden />,
      items: perms.memory_writes,
      mono: true,
    },
    {
      label: t('graphReads'),
      icon: <Database className="size-3.5" aria-hidden />,
      items: perms.graph_reads,
      mono: true,
    },
    {
      label: t('graphWrites'),
      icon: <Database className="size-3.5" aria-hidden />,
      items: perms.graph_writes,
      mono: true,
    },
    {
      label: t('networkOutbound'),
      icon: <Globe className="size-3.5" aria-hidden />,
      items: perms.network_outbound,
      mono: true,
    },
  ];

  const active = groups.filter((g) => g.items.length > 0);

  // Spec 004 — boolean capability flags (no string list). Surfaced so an
  // operator reviewing a Hub plugin sees its runtime-credential powers.
  const flags: Array<{ label: string; icon: React.ReactNode }> = [];
  if (perms.secrets_runtime_write) {
    flags.push({
      label: t('flagRuntimeSecrets'),
      icon: <KeyRound className="size-3.5" aria-hidden />,
    });
  }
  if (perms.flows) {
    flags.push({
      label: t('flagCredentialFlows'),
      icon: <ShieldAlert className="size-3.5" aria-hidden />,
    });
  }

  if (active.length === 0 && flags.length === 0) {
    return (
      <p className="text-sm italic text-[color:var(--faint-ink)]">
        {t('none')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {flags.length > 0 ? (
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted-ink)]">
            <KeyRound className="size-3.5" aria-hidden />
            {t('runtimeCredentials')}
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
            {flags.map((flag) => (
              <Chip
                key={flag.label}
                tone="accent"
                className="normal-case tracking-normal"
              >
                {flag.label}
              </Chip>
            ))}
          </ul>
        </div>
      ) : null}
      {active.map((group) => (
        <div key={group.label}>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted-ink)]">
            {group.icon}
            {group.label}
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
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
async function CapabilitiesBlock({
  provides,
  requires,
}: {
  provides: string[];
  requires: string[];
}): Promise<React.ReactElement> {
  const t = await getTranslations('store.detail.capabilities');
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--muted-ink)]">
          {t('provides')}
        </div>
        {provides.length === 0 ? (
          <p className="mt-2 text-[12px] italic text-[color:var(--faint-ink)]">
            {t('noneDeclared')}
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
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
          {t('requires')}
        </div>
        {requires.length === 0 ? (
          <p className="mt-2 text-[12px] italic text-[color:var(--faint-ink)]">
            {t('noRequirements')}
          </p>
        ) : (
          <>
            <ul className="mt-2 flex flex-wrap gap-2">
              {requires.map((cap) => (
                <li key={cap}>
                  <Chip tone="muted" className="font-mono-num normal-case tracking-normal">
                    {cap}
                  </Chip>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--faint-ink)]">
              {t('installHint')}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

