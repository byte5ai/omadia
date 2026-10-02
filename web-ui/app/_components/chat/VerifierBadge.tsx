'use client';

import { useTranslations } from 'next-intl';

import {
  verifierBadgeView,
  type VerifierBadgeTone,
} from '../../_lib/verifierBadge';

const TONE_CLASS: Record<VerifierBadgeTone, string> = {
  success:
    'bg-[color:var(--success)]/10 text-[color:var(--success)] ring-[color:var(--success)]',
  warning:
    'bg-[color:var(--warning)]/10 text-[color:var(--warning)] ring-[color:var(--warning)]',
  info: 'bg-[color:var(--info)]/10 text-[color:var(--info)] ring-[color:var(--info)]',
  danger:
    'bg-[color:var(--danger)]/10 text-[color:var(--danger)] ring-[color:var(--danger)]',
  neutral:
    'bg-[color:var(--fg-subtle)]/10 text-[color:var(--fg-subtle)] ring-[color:var(--fg-subtle)]',
};

interface VerifierBadgeProps {
  /** The turn's verifier summary (`Message.verifier`); untrusted shape. */
  summary: unknown;
}

/**
 * Footer chip stating what the answer verifier concluded for this turn.
 * Green only for a verified answer with checked claims; a turn with nothing
 * checkable, or a verifier that could not run, gets its own neutral chip so
 * it can never be mistaken for a check. The tooltip explains the state.
 */
export function VerifierBadge({
  summary,
}: VerifierBadgeProps): React.ReactElement | null {
  const t = useTranslations('chat.verifier');
  const view = verifierBadgeView(summary);
  if (!view) return null;
  return (
    <span
      className={`ml-3 inline-flex items-center rounded-full px-2 py-0.5 font-medium ring-1 ${TONE_CLASS[view.tone]}`}
      title={t(`hint.${view.hint}`, { count: view.count })}
      data-verifier-state={view.state}
    >
      {t(`label.${view.state}`)}
    </span>
  );
}
