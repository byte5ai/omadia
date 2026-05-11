import type { PluginInstallState } from '../../_lib/storeTypes';
import { cn } from '../../_lib/cn';

interface StateBadgeProps {
  state: PluginInstallState;
  isLegacy?: boolean;
  className?: string;
}

const LABEL: Record<PluginInstallState, string> = {
  available: 'Verfügbar',
  installed: 'Installiert',
  'update-available': 'Update verfügbar',
  incompatible: 'Inkompatibel',
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
  if (isLegacy) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
          'text-[11px] font-medium uppercase tracking-[0.12em]',
          'text-[color:var(--warning)] border-[color:var(--warning)]/50 bg-[color:var(--warning)]/12',
          className,
        )}
      >
        <span className="-mt-0.5" aria-hidden>
          ⚠
        </span>
        Migration&nbsp;nötig
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5',
        'text-[11px] font-medium uppercase tracking-[0.12em]',
        STYLE[state],
        className,
      )}
    >
      {LABEL[state]}
    </span>
  );
}
