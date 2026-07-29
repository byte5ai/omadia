'use client';

import { useTranslations } from 'next-intl';

import type { DirectLineSessionState } from '../../_lib/chatSessions';

interface DirectLineStickyBannerProps {
  session: DirectLineSessionState;
  /** Sends the reserved exit directive through the normal turn path. */
  onExit: () => void;
  disabled?: boolean;
}

/**
 * #445 — persistent "you are talking to <specialist>" indicator.
 *
 * Sits directly above the composer so the binding is visible exactly where the
 * user types. It renders only while a binding is live; the server sends
 * `{ active: false }` on every unbound turn, so this disappears on the very
 * next turn after an exit, a restart or a TTL expiry rather than going stale.
 *
 * Lume state recipe: text + edge + a low tint, never a solid fill and never a
 * spinner — this is a steady state, not activity.
 */
export function DirectLineStickyBanner({
  session,
  onExit,
  disabled,
}: DirectLineStickyBannerProps): React.ReactElement | null {
  const t = useTranslations('directLine');
  if (!session.active || !session.label) return null;

  return (
    <div
      className="mb-2 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ring-1 bg-[color:var(--accent)]/6 ring-[color:var(--accent)]/30"
      role="status"
      aria-live="polite"
    >
      <span className="text-[color:var(--accent)]">
        {t('stickyActive', { label: session.label })}
      </span>
      <button
        type="button"
        onClick={onExit}
        disabled={disabled ?? false}
        className="shrink-0 rounded-md px-2 py-1 text-xs ring-1 ring-[color:var(--accent)]/30 text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10 disabled:opacity-50"
      >
        {t('stickyExit')}
      </button>
    </div>
  );
}
