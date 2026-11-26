'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChoiceCard } from '../../../../_components/ChoiceCard';
import { Button } from '../../../../_components/ui/Button';
import { ApiError, cancelBuilderUserChoice, resolveBuilderUserChoice } from '../../../../_lib/api';

export interface BuilderChoice {
  choiceId: string;
  question: string;
  options: ReadonlyArray<{ value: string; label: string; description?: string }>;
}

export function BuilderChoiceCard({
  draftId,
  choice,
  onResolved,
  onReply,
}: {
  draftId: string;
  choice: BuilderChoice;
  onResolved?: (choiceId: string) => void;
  onReply: (text: string) => void;
}): React.ReactElement {
  const t = useTranslations('builder.choice');
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(selection: { value: string } | { answer: string } | null) {
    if (submitting) return;
    setSubmitting(true);
    setFailed(false);
    const ids = { draftId, choiceId: choice.choiceId };
    try {
      if (selection === null) {
        await cancelBuilderUserChoice(ids);
      } else {
        await resolveBuilderUserChoice({ ...ids, ...selection });
        const text = 'answer' in selection
          ? selection.answer
          : choice.options.find((option) => option.value === selection.value)?.label ?? selection.value;
        onReply(text);
      }
      onResolved?.(choice.choiceId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        onResolved?.(choice.choiceId);
      } else {
        setFailed(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ChoiceCard
      choice={{ ...choice, options: [...choice.options] }}
      disabled={submitting}
      onChoose={(value) => { void submit({ value }); }}
    >
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (answer.trim()) void submit({ answer: answer.trim() });
        }}
      >
        <input
          type="text"
          aria-label={t('answerLabel')}
          placeholder={t('answerLabel')}
          maxLength={2000}
          value={answer}
          disabled={submitting}
          onChange={(event) => setAnswer(event.target.value)}
          className="min-w-32 flex-1 rounded border border-[color:var(--divider)] bg-[color:var(--bg)] px-2 text-sm"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={submitting || !answer.trim()}>
          {t('send')}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => { void submit(null); }}>
          {t('dismiss')}
        </Button>
      </form>
      {failed && <p role="alert" className="mt-2 text-xs text-[color:var(--danger)]">{t('failed')}</p>}
    </ChoiceCard>
  );
}
