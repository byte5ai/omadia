import { cn } from '../../_lib/cn';

/**
 * Workaround lifecycle badge for the store + builder UI.
 *
 *   `active`            — yellow, "Workaround aktiv (#N)"
 *   `update-available`  — orange, "Update verfügbar — Plattform-Fix gemerged"
 *   `none`              — renders nothing (parent decides when to show it)
 *
 * Mirrors the styling pattern of StateBadge so the two badges line
 * up visually in the same row.
 */

export type WorkaroundBadgeStatus = 'active' | 'update-available' | 'none';

interface WorkaroundBadgeProps {
  status: WorkaroundBadgeStatus;
  issueNumber?: number;
  issueUrl?: string;
  className?: string;
}

const LABEL: Record<Exclude<WorkaroundBadgeStatus, 'none'>, string> = {
  active: 'Workaround aktiv',
  'update-available': 'Update verfügbar',
};

const STYLE: Record<Exclude<WorkaroundBadgeStatus, 'none'>, string> = {
  active:
    'text-[color:var(--warning)] border-[color:var(--warning)]/50 bg-[color:var(--warning)]/12',
  'update-available':
    'text-[color:var(--accent)] border-[color:var(--accent)]/50 bg-[color:var(--accent)]/10',
};

export function WorkaroundBadge({
  status,
  issueNumber,
  issueUrl,
  className,
}: WorkaroundBadgeProps): React.ReactElement | null {
  if (status === 'none') return null;

  const label =
    issueNumber !== undefined
      ? `${LABEL[status]} (#${String(issueNumber)})`
      : LABEL[status];

  const content = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-[11px] font-medium uppercase tracking-[0.12em]',
        STYLE[status],
        className,
      )}
    >
      <span aria-hidden>{status === 'update-available' ? '↻' : '⚠'}</span>
      {label}
    </span>
  );

  if (issueUrl) {
    return (
      <a
        href={issueUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="no-underline"
        aria-label={`${label} — issue im Browser öffnen`}
      >
        {content}
      </a>
    );
  }
  return content;
}
