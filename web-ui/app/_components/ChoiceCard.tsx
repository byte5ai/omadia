'use client';

import type React from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
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
    <div className="mt-3 rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/10 p-3">
      <div className="mb-1 text-xs font-semibold text-[color:var(--accent)]">
        {t('clarifyKicker')}
      </div>
      <div className="mb-2 text-sm text-[color:var(--fg-strong)]">
        {choice.question}
      </div>
      {choice.rationale && (
        <div className="mb-2 text-xs text-[color:var(--fg-muted)] italic">
          {choice.rationale}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {choice.options.map((opt, idx) => (
          <Button
            key={`${opt.value}-${String(idx)}`}
            variant={idx === 0 ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => {
              onChoose(opt.value);
            }}
            disabled={disabled}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
