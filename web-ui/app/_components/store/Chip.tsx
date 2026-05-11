import { cn } from '../../_lib/cn';

interface ChipProps {
  children: React.ReactNode;
  tone?: 'default' | 'muted' | 'mono' | 'accent';
  className?: string;
}

export function Chip({
  children,
  tone = 'default',
  className,
}: ChipProps): React.ReactElement {
  const toneClass = {
    default:
      'border-[color:var(--rule-strong)] text-[color:var(--ink)]',
    muted:
      'border-[color:var(--rule)] text-[color:var(--muted-ink)]',
    mono:
      'border-[color:var(--rule)] text-[color:var(--muted-ink)] font-mono-num tracking-normal',
    accent:
      'border-[color:var(--oxblood)] text-[color:var(--oxblood)]',
  }[tone];

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] leading-5',
        tone !== 'mono' && 'uppercase tracking-[0.14em]',
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  );
}
