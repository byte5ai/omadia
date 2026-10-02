'use client';

import { useTranslations } from 'next-intl';

interface Props {
  /**
   * True when the bubble already renders the server's notice as its text —
   * on the live stream always: the server composes it in the OPERATOR's
   * locale (not the UI locale) for channels that render the answer and
   * nothing else. The card then shows only its UI-localized heading. False
   * only when no text is on screen; the card then explains on its own.
   */
  hasAnswerText: boolean;
}

/**
 * Status line for an answer the answer verifier withheld in `enforce` mode
 * (`done.answerSource === 'verifier-blocked'`): it could not confirm the
 * answer — a contradiction, claims it could not confirm, or a check that
 * could not be completed — so the model's answer never reached the browser
 * and the bubble holds the server's notice instead. Without this heading the
 * notice would read like an ordinary reply. Mirrors `TurnIncompleteNotice`.
 */
export function VerifierBlockedNotice({ hasAnswerText }: Props): React.ReactElement {
  const t = useTranslations('chat');
  return (
    <div
      role="status"
      className="mb-2 rounded border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 p-3 text-xs text-[color:var(--warning)]"
    >
      <div className="mb-1 flex items-center gap-2 font-semibold">
        {/* The icon repeats the border/text colour rather than carrying the
            meaning alone — colour is never the sole signal. */}
        <span aria-hidden>⚠</span>
        <span>{t('verifierBlocked.heading')}</span>
      </div>
      {!hasAnswerText && <p>{t('verifierBlocked.body')}</p>}
    </div>
  );
}
