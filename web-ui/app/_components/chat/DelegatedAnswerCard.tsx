'use client';

import { useTranslations } from 'next-intl';

import type { DelegatedAnswer } from '../../_lib/chatSessions';

interface DelegatedAnswerCardProps {
  answer: DelegatedAnswer;
  className?: string;
}

/**
 * #332 Layer 2 (gap-closure) — the harness-owned, attributed verbatim answer
 * for a Direct-Line turn (`#<agent> <question>`). Rendered as a visually
 * distinct block, separate from the orchestrator's own `content`, so the
 * user can see the specialist's exact words — the orchestrator could not
 * have removed or reworded them.
 *
 * Deliberately rendered as plain text (`whitespace-pre-wrap`), NOT through
 * the Markdown component: the point is byte-for-byte fidelity to what the
 * specialist actually said, not richly-formatted prose. `status: 'error'`
 * still renders here — a faithful failure message, never a cover-up.
 */
export function DelegatedAnswerCard({
  answer,
  className,
}: DelegatedAnswerCardProps): React.ReactElement {
  const t = useTranslations('directLine');
  const isError = answer.status === 'error';

  return (
    <div
      className={[
        'mt-2 rounded-lg px-3 py-2 text-sm ring-1',
        isError
          ? 'bg-[color:var(--danger)]/8 ring-[color:var(--danger-edge)]'
          : 'bg-[color:var(--accent)]/6 ring-[color:var(--accent)]/30',
        className ?? '',
      ].join(' ')}
    >
      <div
        className={[
          'flex items-center gap-1.5 text-[11px] font-medium',
          isError
            ? 'text-[color:var(--danger)]'
            : 'text-[color:var(--accent)]',
        ].join(' ')}
      >
        <span aria-hidden="true">💬</span>
        <span>{t('delegatedAnswerFrom', { label: answer.label })}</span>
      </div>
      <div className="mt-1 whitespace-pre-wrap text-[color:var(--fg-strong)]">
        {answer.text}
      </div>
      <div className="mt-1 text-[10px] italic text-[color:var(--fg-subtle)]">
        {t('delegatedAnswerCaption')}
      </div>
    </div>
  );
}
