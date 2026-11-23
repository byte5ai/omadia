'use client';

import { useState } from 'react';

/** Up to two initials of a display name; `?` for an empty one. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const second = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

const SIZE_CLASS = {
  sm: 'size-5 text-[9px]',
  md: 'size-8 text-xs',
  lg: 'size-12 text-base',
} as const;

export interface AgentAvatarProps {
  name: string;
  /** Image URL; `null` or a failing image shows the initials instead. */
  url: string | null;
  size?: keyof typeof SIZE_CLASS;
}

/**
 * The face of an agent. Decorative: the name is always rendered next to it, so
 * the image carries an empty alt text and the initials are hidden from
 * assistive technology.
 */
export function AgentAvatar(props: AgentAvatarProps): React.ReactElement {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const sizeClass = SIZE_CLASS[props.size ?? 'sm'];
  const showImage = props.url !== null && props.url !== failedUrl;

  if (showImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- same-origin avatar behind the /bot-api proxy; not an optimisable static asset
      <img
        src={props.url ?? undefined}
        alt=""
        className={`${sizeClass} shrink-0 rounded-full object-cover`}
        onError={() => setFailedUrl(props.url)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${sizeClass} inline-flex shrink-0 items-center justify-center rounded-full bg-[color:var(--accent)]/15 font-semibold text-[color:var(--accent)]`}
    >
      {initialsOf(props.name)}
    </span>
  );
}
