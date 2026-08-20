import Link from 'next/link';
import { AlertTriangle, ArrowUpRight, RefreshCw, Store, Wrench } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { pickLocalized } from '../../_lib/localized';
import type { Plugin } from '../../_lib/storeTypes';
import { Chip } from './Chip';
import { PluginIcon } from './PluginIcon';
import { StateBadge } from './StateBadge';

interface PluginCardProps {
  plugin: Plugin;
  /** OM-31 — collision-resolved initials computed once for the whole grid by
   *  `deriveInitialsForSet`. Optional: the card falls back to the pure
   *  single-name derivation when the caller has no full list. */
  initials?: string;
}

export function PluginCard({
  plugin,
  initials,
}: PluginCardProps): React.ReactElement {
  const t = useTranslations('store.card');
  const locale = useLocale();
  const format = useFormatter();
  // OM-28 (#602) — prefer the manifest's localized description; fall back to
  // the plain English string every manifest has carried so far.
  const localizedDescription =
    pickLocalized(plugin.description_localized, locale) ?? plugin.description;
  // OM-15 (#602) — installation-effort line composed from the structured
  // `setup_profile`, so the wording stays localized (next-intl) rather than
  // baked into the manifest. Only the parts the manifest declared are shown; an
  // empty profile renders nothing. This is decision-support the tester lacked
  // BEFORE install ("~15 min · Google Workspace super-admin required").
  const profile = plugin.setup_profile;
  const profileParts = profile
    ? [
        profile.audience
          ? t(`setupProfile.audience.${profile.audience}`)
          : null,
        typeof profile.estimated_minutes === 'number'
          ? t('setupProfile.minutes', { minutes: profile.estimated_minutes })
          : null,
        pickLocalized(profile.requirement, locale) ?? null,
      ].filter((p): p is string => Boolean(p))
    : [];
  const isLegacy = plugin.categories.includes('legacy');
  const visibleCategories = plugin.categories
    .filter((c) => c !== 'legacy')
    .slice(0, 3);
  const visibleIntegrations = plugin.integrations_summary.slice(0, 2);
  const hasUpdate = plugin.install_state === 'update-available';

  return (
    <Link
      href={`/store/${encodeURIComponent(plugin.id)}`}
      className="group relative flex flex-col rounded-lg bg-[color:var(--bg-elevated)] p-6 shadow-[0_2px_6px_rgba(0,75,115,0.08)] transition-[transform,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-out)] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(0,75,115,0.10)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
    >
      {/* Update "Störer" — prominent top-right sticker. Only on plugins where a
          configured registry advertises a newer version than the installed one
          (C6). Overhangs the corner slightly for attention. */}
      {hasUpdate ? (
        <span
          className="absolute -right-2 -top-2 z-10 inline-flex items-center gap-1 rounded-full bg-[color:var(--accent)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[color:var(--accent-fg)] shadow-[0_4px_12px_rgba(0,75,115,0.35)] ring-2 ring-[color:var(--bg-elevated)]"
          title={
            plugin.available_version
              ? t('updateTitleWithVersion', {
                  from: plugin.version,
                  to: plugin.available_version,
                })
              : t('updateTitle')
          }
        >
          <RefreshCw className="size-3" aria-hidden />
          {t('updateSticker')}
          {plugin.available_version ? (
            <span className="font-mono-num font-semibold normal-case tracking-normal opacity-90">
              {plugin.available_version}
            </span>
          ) : null}
        </span>
      ) : null}

      <div className="flex items-start gap-4">
        <PluginIcon
          name={plugin.name}
          iconUrl={plugin.icon_url}
          size="md"
          tone={isLegacy ? 'legacy' : 'default'}
          id={plugin.id}
          initials={initials}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="font-display text-[22px] leading-[1.15] text-[color:var(--fg-strong)]">
            {plugin.name}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--fg-muted)]">
            <span className="font-mono-num">{plugin.id}</span>
            <span className="text-[color:var(--fg-subtle)]">·</span>
            <span className="font-mono-num">v{plugin.version}</span>
          </div>
        </div>
      </div>

      {/* OM-31 — `line-clamp-3` hides the tail with no affordance. A native
          title tooltip surfaces the full text without nesting interactive
          content (e.g. <details>) inside this card's <Link>. */}
      <p
        className="mt-4 line-clamp-3 text-[14px] leading-relaxed text-[color:var(--fg-muted)]"
        title={localizedDescription || undefined}
      >
        {localizedDescription || <em>{t('noDescription')}</em>}
      </p>

      {/* OM-15 (#602) — setup prerequisites, shown BEFORE install so the
          effort (IT-admin, time, required admin role) is visible while the
          operator is still deciding. */}
      {profileParts.length > 0 ? (
        <p
          className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-[color:var(--fg-subtle)]"
          title={t('setupProfileLabel')}
        >
          <Wrench className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{profileParts.join(' · ')}</span>
        </p>
      ) : null}

      {/* Metadata row. An update-available plugin IS installed — show that
          inline; the update itself is the top-right Störer. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <StateBadge
          state={hasUpdate ? 'installed' : plugin.install_state}
          isLegacy={isLegacy}
          readiness={plugin.readiness}
        />
        {/* Spec 004 — operator-action signal pushed by the active plugin via
            ctx.status. Persists across visits and clears once the plugin
            reports `ok`. Amber = needs_action, red = error. */}
        {plugin.action_status &&
        plugin.action_status.state !== 'ok' ? (
          <span
            className={
              plugin.action_status.state === 'error'
                ? 'inline-flex items-center gap-1 rounded-full bg-[color:var(--danger)]/12 px-2.5 py-0.5 text-[11px] font-semibold text-[color:var(--danger)]'
                : 'inline-flex items-center gap-1 rounded-full bg-[color:var(--warning)]/12 px-2.5 py-0.5 text-[11px] font-semibold text-[color:var(--warning)]'
            }
            title={plugin.action_status.detail ?? undefined}
          >
            <AlertTriangle className="size-3" aria-hidden />
            {plugin.action_status.title ?? t('actionRequired')}
          </span>
        ) : null}
        {/* OM-16/24/33 follow-up — a POSITIVE probe verdict. Only rendered when
            the plugin deliberately reported ok WITH a title ("Verbunden"); the
            kernel-stamped checked_at keeps the claim tied to a moment in time
            instead of reading as a permanent fact. */}
        {plugin.action_status &&
        plugin.action_status.state === 'ok' &&
        plugin.action_status.title ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-[color:var(--success)]/12 px-2.5 py-0.5 text-[11px] font-semibold text-[color:var(--success)]"
            title={plugin.action_status.detail ?? undefined}
          >
            {plugin.action_status.title}
            {plugin.action_status.checked_at ? (
              <span className="font-normal opacity-80">
                {' · '}
                {format.dateTime(new Date(plugin.action_status.checked_at), {
                  timeStyle: 'short',
                })}
              </span>
            ) : null}
          </span>
        ) : null}
        {/* Origin marker — present only on remote-registry (Hub) entries that
            are not yet ingested locally. Lets the Hub view distinguish a
            hub-sourced plugin from a local catalog package at a glance. */}
        {plugin.source ? (
          <Chip tone="accent">
            <Store className="mr-1 size-3" aria-hidden />
            Hub · {plugin.source.registry}
          </Chip>
        ) : null}
        {visibleCategories.map((cat) => (
          <Chip key={cat} tone="muted">
            {cat}
          </Chip>
        ))}
      </div>

      {/* Integrations pinned at bottom */}
      {visibleIntegrations.length > 0 ? (
        <div className="mt-4 border-t border-[color:var(--divider)] pt-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
            <span className="uppercase tracking-[0.18em] text-[color:var(--fg-subtle)]">
              Integration
            </span>
            <span className="text-[color:var(--fg-muted)]">
              {visibleIntegrations.join(' · ')}
              {plugin.integrations_summary.length >
                visibleIntegrations.length && (
                <span className="text-[color:var(--fg-subtle)]">
                  {' '}
                  +{plugin.integrations_summary.length - visibleIntegrations.length}
                </span>
              )}
            </span>
          </div>
        </div>
      ) : null}

      <ArrowUpRight
        className="absolute bottom-5 right-5 size-4 text-[color:var(--accent)] opacity-0 transition group-hover:opacity-100"
        aria-hidden
      />
    </Link>
  );
}
