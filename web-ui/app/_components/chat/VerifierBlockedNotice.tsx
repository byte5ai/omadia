'use client';

import { useTranslations } from 'next-intl';

/** The server's `withheldCause` codes → their catalog keys. */
const CAUSE_KEYS: Readonly<Record<string, string>> = {
  contradicted: 'contradicted',
  tool_not_called: 'toolNotCalled',
  citation_missing: 'citationMissing',
  insufficient_evidence: 'insufficientEvidence',
  check_failed: 'checkFailed',
  not_checked: 'notChecked',
};

interface Props {
  /**
   * True when the bubble already renders the server's notice as its text —
   * on the live stream always: the server composes it in the OPERATOR's
   * locale (not the UI locale) for channels that render the answer and
   * nothing else. The card then shows only its UI-localized heading. False
   * only when no text is on screen; the card then explains on its own.
   */
  hasAnswerText: boolean;
  /**
   * Why the answer was withheld (`VerifierSummary.withheldCause`). The card
   * says exactly that — a missing citation is never called a contradiction.
   * Unknown or absent (summaries from before the field): the general text.
   */
  cause?: unknown;
  /** `VerifierSummary.contradictionCount` — how many claims a source refuted. */
  contradictionCount?: unknown;
}

/**
 * Status line for an answer the answer verifier withheld in `enforce` mode
 * (`done.answerSource === 'verifier-blocked'`): the model's answer never
 * reached the browser and the bubble holds the server's notice instead.
 * Without this heading the notice would read like an ordinary reply. Mirrors
 * `TurnIncompleteNotice`.
 */
export function VerifierBlockedNotice({
  hasAnswerText,
  cause,
  contradictionCount,
}: Props): React.ReactElement {
  const t = useTranslations('chat');
  const causeKey = typeof cause === 'string' ? CAUSE_KEYS[cause] : undefined;
  const count =
    typeof contradictionCount === 'number' && Number.isInteger(contradictionCount) && contradictionCount > 1
      ? contradictionCount
      : 1;
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
      {!hasAnswerText && (
        <p>{causeKey ? t(`verifierBlocked.cause.${causeKey}`, { count }) : t('verifierBlocked.body')}</p>
      )}
    </div>
  );
}
