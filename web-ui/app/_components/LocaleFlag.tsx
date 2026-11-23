import { useId } from 'react';

import type { Locale } from '../../i18n/locales';

/**
 * Inline SVG flags for the language menu. Not emoji: Windows renders
 * regional-indicator pairs as the bare letters "DE"/"GB", which is exactly
 * what a flag is meant to replace. Decorative — the locale name next to it
 * (or the trigger's aria-label) carries the meaning.
 */
export function LocaleFlag({
  locale,
  className = 'h-3 w-[18px]',
}: {
  readonly locale: Locale;
  readonly className?: string;
}): React.ReactElement {
  // Unique per instance: the Union Jack's clip paths are referenced by id,
  // and the flag renders twice while the menu is open (trigger + option).
  const id = useId();
  const cls = `${className} shrink-0 overflow-hidden rounded-[2px] ring-1 ring-[color:var(--border)]`;
  if (locale === 'de') {
    return (
      <svg className={cls} viewBox="0 0 5 3" preserveAspectRatio="none" aria-hidden>
        <rect width="5" height="1" y="0" fill="#000" />
        <rect width="5" height="1" y="1" fill="#DD0000" />
        <rect width="5" height="1" y="2" fill="#FFCE00" />
      </svg>
    );
  }
  const frame = `${id}-frame`;
  const diag = `${id}-diag`;
  return (
    <svg className={cls} viewBox="0 0 60 30" preserveAspectRatio="none" aria-hidden>
      <clipPath id={frame}>
        <path d="M0,0 v30 h60 v-30 z" />
      </clipPath>
      <clipPath id={diag}>
        <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" />
      </clipPath>
      <g clipPath={`url(#${frame})`}>
        <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
        <path
          d="M0,0 L60,30 M60,0 L0,30"
          clipPath={`url(#${diag})`}
          stroke="#C8102E"
          strokeWidth="4"
        />
        <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10" />
        <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
      </g>
    </svg>
  );
}
