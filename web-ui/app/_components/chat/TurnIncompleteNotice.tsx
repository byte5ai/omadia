'use client';

import { useTranslations } from 'next-intl';

interface Props {
  /** Distinct tool names that committed before the turn threw, in commit
   *  order. Rendered verbatim — these are tool ids, not prose. */
  committedTools: readonly string[];
  /** Token matching the `[orchestrator] turn failed (correlationId=…)` server
   *  log line. Absent on middleware older than #1094. */
  correlationId?: string;
  /**
   * True when the bubble already renders answer text. On the live stream this
   * is always the case: the orchestrator expands the marker into a notice at
   * the delivery boundary, in the OPERATOR's disclosure locale (not the UI
   * locale), for channels that render `answer` and nothing else. The card then
   * shows only its UI-localized warning header — repeating the tools and the
   * support token under the same sentence would say everything twice. False
   * only when the text was the bare `<turn-incomplete>` marker, which
   * `parseTurnIncomplete` strips to nothing; this card is then the only
   * explanation on screen.
   */
  hasAnswerText: boolean;
}

/**
 * #1094 — warning shown in place of a degraded turn's answer.
 *
 * A turn that throws after a tool already committed still ends as `done` (an
 * `error` would make the next turn re-invoke the committed tool, #506). Before
 * this, the orchestrator filled that `done` with a hardcoded English sentence
 * claiming the actions "completed successfully" — rendered in ordinary answer
 * styling, in a German UI, with nothing marking it as a failure and no token
 * to hand to support. The server now sends a `degraded` flag with the facts
 * and a notice composed in the operator's locale; this card adds the
 * UI-localized warning heading, and renders the catalog body itself only when
 * no answer text is on screen (see `hasAnswerText`).
 *
 * Deliberately states BOTH halves of the truth: the listed tools really did
 * run (so the user must not simply repeat a side-effecting request blindly),
 * and the question itself is unanswered.
 */
export function TurnIncompleteNotice({
  committedTools,
  correlationId,
  hasAnswerText,
}: Props): React.ReactElement {
  // `chat`, not `chat.turnIncomplete`: the support-reference line is the same
  // sentence the error path already shows (#641), so it reuses that key rather
  // than duplicating the string under a second one.
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
        <span>{t('turnIncomplete.heading')}</span>
      </div>
      {!hasAnswerText && (
        <>
          {/* The tool list only renders when there is one, so the body must
              not point at a list that is not on screen — `committedTools` can
              legitimately arrive empty (older middleware sending only the
              flag, or a marker with an empty `tools` attribute). */}
          <p>
            {committedTools.length > 0
              ? t('turnIncomplete.body')
              : t('turnIncomplete.bodyNoTools')}
          </p>
          {committedTools.length > 0 && (
            <p className="mt-1">
              {t('turnIncomplete.completedTools')}{' '}
              <span className="font-mono">{committedTools.join(', ')}</span>
            </p>
          )}
          {correlationId !== undefined && correlationId !== '' && (
            <p className="mt-1 opacity-80">
              {t('errorCorrelationRef', { id: correlationId })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
