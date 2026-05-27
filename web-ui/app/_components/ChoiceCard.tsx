'use client';

import type React from 'react';
import { useTranslations } from 'next-intl';

import type { PendingUserChoice } from '../_lib/chatSessions';

export type { PendingUserChoice };

/**
 * Smart-Card clarification question with 2-4 option buttons.
 *
 * Used by every surface that wants to render the `ask_user_choice`
 * (orchestrator) or `user_choice_required` (builder spec-event-bus)
 * flow — main chat, BuilderChatPane and PreviewChatPane all reuse
 * this component so the look and accessibility behaviour stay in
 * sync. The caller owns the `onChoose` semantics (post to resolver
 * endpoint vs. submit a fresh user turn).
 */
export function ChoiceCard({
  choice,
  disabled,
  onChoose,
}: {
  choice: PendingUserChoice;
  disabled: boolean;
  onChoose: (value: string) => void;
}): React.ReactElement {
  const t = useTranslations('chat');
  return (
    <div className="mt-3 rounded border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-800 dark:bg-indigo-950/40">
      <div className="mb-1 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
        {t('clarifyKicker')}
      </div>
      <div className="mb-2 text-sm text-neutral-900 dark:text-neutral-100">
        {choice.question}
      </div>
      {choice.rationale && (
        <div className="mb-2 text-xs text-neutral-500 italic dark:text-neutral-400">
          {choice.rationale}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {choice.options.map((opt, idx) => (
          <button
            key={`${opt.value}-${String(idx)}`}
            type="button"
            onClick={() => {
              onChoose(opt.value);
            }}
            disabled={disabled}
            className={[
              'rounded border px-3 py-1.5 text-xs font-medium transition',
              idx === 0
                ? 'border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700 dark:border-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-600'
                : 'border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200',
              'disabled:cursor-not-allowed disabled:opacity-40',
            ].join(' ')}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
