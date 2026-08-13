import { useTranslations } from 'next-intl';

import type { PluginVerdict } from '../../_lib/storeTypes';
import { cn } from '../../_lib/cn';

export type PluginVerdictSeverity = PluginVerdict['severity'] | 'not_yet_scanned';

interface PluginVerdictBadgeProps {
  severity: PluginVerdictSeverity;
  className?: string;
}

/**
 * Advisory code-scan badge for executable plugin packages (issue #453) —
 * the plugin-surface sibling of `SkillVerdictBadge` (#436/#452), sharing
 * its severity scale, iconography, and the `skills.verdict` label strings.
 * Like there: labels read as signal statements, never as proof of safety,
 * and the verdict never blocks anything in v1.
 */
const LABEL_KEY: Record<PluginVerdictSeverity, string> = {
  no_signals: 'noSignals',
  flagged: 'flagged',
  high_risk: 'highRisk',
  scan_failed: 'scanFailed',
  too_large_to_scan: 'tooLargeToScan',
  pending: 'pending',
  not_yet_scanned: 'notYetScanned',
};

const ICON: Record<PluginVerdictSeverity, string> = {
  no_signals: '○',
  flagged: '⚠',
  high_risk: '⚠',
  scan_failed: '✕',
  too_large_to_scan: '✕',
  pending: '…',
  not_yet_scanned: '○',
};

const STYLE: Record<PluginVerdictSeverity, string> = {
  no_signals:
    'text-[color:var(--fg-muted)] border-[color:var(--border)] bg-[color:var(--bg-soft)]',
  flagged:
    'text-[color:var(--warning)] border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10',
  high_risk:
    'text-[color:var(--danger)] border-[color:var(--danger)]/50 bg-[color:var(--danger)]/8',
  scan_failed:
    'text-[color:var(--fg-muted)] border-[color:var(--border-strong)] bg-[color:var(--bg-soft)]',
  too_large_to_scan:
    'text-[color:var(--fg-muted)] border-[color:var(--border-strong)] bg-[color:var(--bg-soft)]',
  pending:
    'text-[color:var(--accent)] border-[color:var(--accent)]/50 bg-[color:var(--accent)]/10',
  not_yet_scanned:
    'text-[color:var(--fg-muted)] border-[color:var(--border)] bg-[color:var(--bg-soft)]',
};

export function PluginVerdictBadge({
  severity,
  className,
}: PluginVerdictBadgeProps): React.ReactElement {
  const t = useTranslations('skills.verdict');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5',
        'text-[11px] font-medium uppercase tracking-[0.1em]',
        STYLE[severity],
        className,
      )}
    >
      <span className="-mt-0.5" aria-hidden>
        {ICON[severity]}
      </span>
      {t(LABEL_KEY[severity])}
    </span>
  );
}
