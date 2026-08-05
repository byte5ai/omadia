import { cn } from '../../_lib/cn';
import { deriveInitials, toneIndex } from '../../_lib/pluginInitials';

interface PluginIconProps {
  name: string;
  iconUrl: string | null;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'legacy';
  /** OM-31 — plugin id, hashed to pick one of the accent tints so a grid of
   *  similarly-named plugins is scannable. Optional: without it every tile
   *  keeps the single legacy accent. */
  id?: string;
  /** OM-31 — collision-resolved initials from `deriveInitialsForSet`, supplied
   *  wherever the caller knows the whole list. Falls back to the pure
   *  single-name derivation (server/client safe) when absent. */
  initials?: string;
}

const TONE_CLASSES: Record<NonNullable<PluginIconProps['tone']>, string> = {
  default:
    'bg-[color:var(--accent)]/10 text-[color:var(--accent)] ring-[color:var(--accent)]/35',
  legacy:
    'bg-[color:var(--warning)]/12 text-[color:var(--warning)] ring-[color:var(--warning)]/40',
};

/**
 * OM-31 — accent tints for the default tone. Every tile used to carry the
 * identical accent, so even distinct initials looked alike in a grid.
 * Lume-conformant: text + ring only over the same faint wash the tile already
 * had, and all values are existing tokens from `app/_lib/theme.css` — no new
 * colours are introduced.
 */
const ACCENT_TINTS = [
  'bg-[color:var(--accent)]/10 text-[color:var(--accent)] ring-[color:var(--accent)]/35',
  'bg-[color:var(--fg-strong)]/8 text-[color:var(--fg-strong)] ring-[color:var(--fg-strong)]/30',
  'bg-[color:var(--success)]/10 text-[color:var(--success)] ring-[color:var(--success)]/35',
  'bg-[color:var(--fg-muted)]/10 text-[color:var(--fg-muted)] ring-[color:var(--fg-muted)]/35',
] as const;

const SIZE_CLASSES: Record<NonNullable<PluginIconProps['size']>, string> = {
  sm: 'size-9 text-sm',
  md: 'size-14 text-xl',
  lg: 'size-24 text-4xl',
};

/**
 * Circular icon tile — echoes the byte5 "Kreiselement" (signet circle).
 * Falls back to short initials rendered in Days One when no icon URL.
 */
export function PluginIcon({
  name,
  iconUrl,
  size = 'md',
  tone = 'default',
  id,
  initials,
}: PluginIconProps): React.ReactElement {
  const toneClass =
    tone === 'legacy' || !id
      ? TONE_CLASSES[tone]
      : (ACCENT_TINTS[toneIndex(id, ACCENT_TINTS.length)] ??
        TONE_CLASSES.default);

  if (iconUrl) {
    return (
      <div
        className={cn(
          'relative shrink-0 overflow-hidden rounded-full ring-1',
          SIZE_CLASSES[size],
          toneClass,
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
        toneClass,
      )}
      aria-hidden
    >
      {initials ?? deriveInitials(name)}
    </div>
  );
}
