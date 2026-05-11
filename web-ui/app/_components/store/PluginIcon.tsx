import { cn } from '../../_lib/cn';

interface PluginIconProps {
  name: string;
  iconUrl: string | null;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'legacy';
}

const TONE_CLASSES: Record<NonNullable<PluginIconProps['tone']>, string> = {
  default:
    'bg-[color:var(--accent)]/10 text-[color:var(--accent)] ring-[color:var(--accent)]/35',
  legacy:
    'bg-[color:var(--warning)]/12 text-[color:var(--warning)] ring-[color:var(--warning)]/40',
};

const SIZE_CLASSES: Record<NonNullable<PluginIconProps['size']>, string> = {
  sm: 'size-9 text-sm',
  md: 'size-14 text-xl',
  lg: 'size-24 text-4xl',
};

/**
 * Circular icon tile — echoes the byte5 "Kreiselement" (signet circle).
 * Falls back to 2-char initials rendered in Days One when no icon URL.
 */
export function PluginIcon({
  name,
  iconUrl,
  size = 'md',
  tone = 'default',
}: PluginIconProps): React.ReactElement {
  if (iconUrl) {
    return (
      <div
        className={cn(
          'relative shrink-0 overflow-hidden rounded-full ring-1',
          SIZE_CLASSES[size],
          TONE_CLASSES[tone],
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={iconUrl} alt="" className="size-full object-cover" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-full ring-1',
        'font-display',
        SIZE_CLASSES[size],
        TONE_CLASSES[tone],
      )}
      aria-hidden
    >
      {deriveInitials(name)}
    </div>
  );
}

function deriveInitials(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) {
    const first = words[0] ?? '';
    return first.slice(0, 2).toUpperCase();
  }
  const first = words[0]?.[0] ?? '';
  const second = words[1]?.[0] ?? '';
  return `${first}${second}`.toUpperCase();
}
