import { useFormatter, useTranslations } from 'next-intl';

import type { PluginInstallState, PluginReadiness } from '../../_lib/storeTypes';
import { cn } from '../../_lib/cn';

interface StateBadgeProps {
  state: PluginInstallState;
  isLegacy?: boolean;
  /**
   * OM-16 — kernel-derived readiness. Orthogonal to `state`: an installed
   * plugin whose credentials were emptied is still `install_state:
   * 'installed'`, and the badge must say so instead of an unqualified green
   * "Installiert". Absent on payloads from a pre-OM-16 middleware, in which
   * case the badge renders exactly as it used to.
   */
  readiness?: PluginReadiness;
  className?: string;
}

/** Message-key leaves under `store.stateBadge` — translated at render. */
const LABEL_KEY: Record<PluginInstallState, string> = {
  available: 'available',
  installed: 'installed',
  'update-available': 'updateAvailable',
  incompatible: 'incompatible',
};

const STYLE: Record<PluginInstallState, string> = {
  available:
    'text-[color:var(--fg)] border-[color:var(--border-strong)] bg-[color:var(--bg-soft)]',
  installed:
    'text-[color:var(--success)] border-[color:var(--success)]/50 bg-[color:var(--success)]/10',
  'update-available':
    'text-[color:var(--accent)] border-[color:var(--accent)]/50 bg-[color:var(--accent)]/10',
  incompatible:
    'text-[color:var(--danger)] border-[color:var(--danger)]/50 bg-[color:var(--danger)]/8',
};

const WARNING_STYLE =
  'text-[color:var(--warning)] border-[color:var(--warning)]/50 bg-[color:var(--warning)]/12';
const DANGER_STYLE =
  'text-[color:var(--danger)] border-[color:var(--danger)]/50 bg-[color:var(--danger)]/8';

const PILL =
  'inline-flex items-center gap-2 rounded-full border px-3 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em]';

export function StateBadge({
  state,
  isLegacy,
  readiness,
  className,
}: StateBadgeProps): React.ReactElement {
  const t = useTranslations('store.stateBadge');
  const format = useFormatter();

  if (isLegacy) {
    return (
      <span className={cn(PILL, WARNING_STYLE, className)}>
        <span className="-mt-0.5" aria-hidden>
          ⚠
        </span>
        {t('migrationNeeded')}
      </span>
    );
  }

  // OM-16 — readiness only ever REPLACES the label for a plugin the registry
  // considers present. An 'available' or 'incompatible' plugin has no
  // readiness story to tell.
  const isPresent = state === 'installed' || state === 'update-available';

  if (isPresent && readiness?.state === 'errored') {
    return (
      <span
        className={cn(PILL, DANGER_STYLE, className)}
        title={readiness.error_detail ?? undefined}
      >
        {t('errored')}
      </span>
    );
  }

  if (isPresent && readiness?.state === 'config_required') {
    const missing = readiness.missing_fields;
    return (
      <span
        className={cn(PILL, WARNING_STYLE, className)}
        title={
          missing.length > 0
            ? t('missingFields', { fields: missing.join(', ') })
            : undefined
        }
      >
        {t('configRequired')}
      </span>
    );
  }

  if (isPresent && readiness?.state === 'ready' && readiness.verified_at) {
    const at = new Date(readiness.verified_at);
    if (!Number.isNaN(at.getTime())) {
      return (
        <span className={cn(PILL, STYLE.installed, className)}>
          {t('readyVerified', {
            time: format.dateTime(at, {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
          })}
        </span>
      );
    }
  }

  return (
    <span className={cn(PILL, STYLE[state], className)}>
      {t(LABEL_KEY[state])}
    </span>
  );
}
