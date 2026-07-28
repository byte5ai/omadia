import { useTranslations } from 'next-intl';

import type { SkillVerdictSeverity } from '../../_lib/agentBuilder';
import { cn } from '../../_lib/cn';

interface SkillVerdictBadgeProps {
  severity: SkillVerdictSeverity;
  className?: string;
}

/**
 * Heuristic-signal badge (issue #436). Deliberately never claims proof of
 * safety — labels read as signal statements, not affirmative guarantees, so
 * the UI's claim never exceeds what a regex/LLM scan can actually back up.
 */
export const SKILL_VERDICT_LABEL_KEY: Record<SkillVerdictSeverity, string> = {
  no_signals: 'noSignals',
  flagged: 'flagged',
  high_risk: 'highRisk',
  scan_failed: 'scanFailed',
  too_large_to_scan: 'tooLargeToScan',
  pending: 'pending',
  not_yet_scanned: 'notYetScanned',
};

const ICON: Record<SkillVerdictSeverity, string> = {
  no_signals: '○',
  flagged: '⚠',
  high_risk: '⚠',
  scan_failed: '✕',
  too_large_to_scan: '✕',
  pending: '…',
  not_yet_scanned: '○',
};

const STYLE: Record<SkillVerdictSeverity, string> = {
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

export function SkillVerdictBadge({
  severity,
  className,
}: SkillVerdictBadgeProps): React.ReactElement {
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
      {t(SKILL_VERDICT_LABEL_KEY[severity])}
    </span>
  );
}
