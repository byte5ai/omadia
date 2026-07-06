import { useTranslations } from 'next-intl';

import type { PluginInstallState } from '../../_lib/storeTypes';
import { cn } from '../../_lib/cn';

interface StateBadgeProps {
  state: PluginInstallState;
  isLegacy?: boolean;
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

export function StateBadge({
  state,
  isLegacy,
  className,
}: StateBadgeProps): React.ReactElement {
  const t = useTranslations('store.stateBadge');
  if (isLegacy) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-3 py-0.5',
          'text-[11px] font-medium uppercase tracking-[0.12em]',
          'text-[color:var(--warning)] border-[color:var(--warning)]/50 bg-[color:var(--warning)]/12',
          className,
        )}
      >
        <span className="-mt-0.5" aria-hidden>
          ⚠
        </span>
        {t('migrationNeeded')}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-3 py-0.5',
        'text-[11px] font-medium uppercase tracking-[0.12em]',
        STYLE[state],
        className,
      )}
    >
      {t(LABEL_KEY[state])}
    </span>
  );
}
