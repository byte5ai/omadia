'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { AGENT_CREATE_STEPS, type AgentCreateResult } from '../../_lib/agentCreateFlow';
import { deleteOperatorAgent } from '../../_lib/agents';

type Failure = Extract<AgentCreateResult, { ok: false }>;

export interface NewAgentOutcomeProps {
  result: Failure;
  onClose: () => void;
  /** Keep the draft and open it in the Agent Builder. */
  onKeep: (slug: string) => void;
}

/**
 * #2049 — a create flow that stopped: which step failed and why, which steps
 * went through, and what is left. A draft that exists stays; the operator
 * opens it to fix it, or deletes it here.
 */
export function NewAgentOutcome({
  result,
  onClose,
  onKeep,
}: NewAgentOutcomeProps): React.ReactElement {
  const t = useTranslations('admin.builder.newAgent');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const draft = deleted ? null : result.slug;

  const removeDraft = async (slug: string): Promise<void> => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteOperatorAgent(slug);
      setDeleted(true);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mt-4 space-y-3 text-sm" data-testid="new-agent-outcome">
      <p role="alert" className="text-[color:var(--danger)]" data-testid="new-agent-failed-step">
        {result.error === 'declined'
          ? t('declined')
          : t('failed', {
              step: t(`steps.${result.failedStep}`),
              detail: result.error,
            })}
      </p>
      <ul className="space-y-0.5 text-xs" data-testid="new-agent-steps">
        {AGENT_CREATE_STEPS.map((step) => (
          <li key={step}>
            {result.done.includes(step)
              ? t('stepDone', { step: t(`steps.${step}`) })
              : step === result.failedStep
                ? t('stepFailed', { step: t(`steps.${step}`) })
                : t('stepNotRun', { step: t(`steps.${step}`) })}
          </li>
        ))}
      </ul>
      {draft ? (
        <p data-testid="new-agent-draft-kept">{t('draftKept', { slug: draft })}</p>
      ) : (
        <p>{deleted ? t('draftDeleted') : t('notCreated')}</p>
      )}
      {deleteError && (
        <p role="alert" className="text-xs text-[color:var(--danger)]">
          {t('deleteFailed', { detail: deleteError })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {draft && (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="new-agent-delete-draft"
              disabled={deleting}
              onClick={() => void removeDraft(draft)}
            >
              {deleting ? t('deleting') : t('deleteDraft')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="new-agent-open-draft"
              disabled={deleting}
              onClick={() => onKeep(draft)}
            >
              {t('openDraft')}
            </Button>
          </>
        )}
        <Button type="button" variant="secondary" size="sm" disabled={deleting} onClick={onClose}>
          {t('close')}
        </Button>
      </div>
    </div>
  );
}
