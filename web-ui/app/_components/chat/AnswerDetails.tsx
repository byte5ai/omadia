'use client';

import { useTranslations } from 'next-intl';

interface AnswerDetailsProps {
  children: React.ReactNode;
}

/**
 * Spec 2042 §5.14, criterion 29/31 — the one collapsed details element under
 * a settled answer (registry decoration `answer_details`). The trace,
 * verification, system-data provenance, consulted agents, mode and privacy
 * receipt live here, reachable on demand, instead of as status chips and
 * footers around the answer.
 */
export function AnswerDetails({ children }: AnswerDetailsProps): React.ReactElement {
  const t = useTranslations('chat.answerDetails');
  return (
    <details
      data-decoration="answer_details"
      className="mt-2 border-t border-current/10 pt-1 text-[11px] text-[color:var(--fg-muted)]"
    >
      <summary className="cursor-pointer select-none" title={t('hint')}>
        {t('summary')}
      </summary>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </details>
  );
}
