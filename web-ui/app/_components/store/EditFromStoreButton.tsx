'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cloneBuilderDraftFromInstalled } from '../../_lib/api';
import type { CloneFromInstalledResponse } from '../../_lib/builderTypes';
import { Button } from '@/app/_components/ui/Button';

/**
 * Edit-from-Store action (B.6-3). Surfaces on the plugin detail page when
 * the agent is currently installed; POSTs to
 * `/api/v1/builder/drafts/from-installed/:agentId` and on success
 * redirects the operator to the cloned draft's workspace.
 *
 * Per Open Question #4 (Edit-from-Store-State = clone): the published
 * plugin stays live during edit. The new draft has no `published_agent_id`
 * link; re-install routes through the install-commit flow with a
 * Conflict-Detection check on `id`/`version`.
 */

export interface EditFromStoreButtonProps {
  publishedAgentId: string;
  /** Optional override for tests — defaults to the real api fn. */
  clone?: (agentId: string) => Promise<CloneFromInstalledResponse>;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'cloning' }
  | { kind: 'failed'; message: string };

export function EditFromStoreButton({
  publishedAgentId,
  clone,
}: EditFromStoreButtonProps): React.ReactElement {
  const t = useTranslations('store.editFromStore');
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const handleClick = async (): Promise<void> => {
    setPhase({ kind: 'cloning' });
    try {
      const fn = clone ?? cloneBuilderDraftFromInstalled;
      const result = await fn(publishedAgentId);
      if (result.ok) {
        router.push(`/store/builder/${encodeURIComponent(result.draftId)}`);
        return;
      }
      setPhase({
        kind: 'failed',
        message: result.code === 'builder.source_draft_not_found'
          ? t('sourceDraftMissing')
          : result.reason === 'quota_exceeded'
            ? t('hintQuotaExceeded')
            : t('cloneFailed'),
      });
    } catch {
      setPhase({
        kind: 'failed',
        message: t('cloneFailed'),
      });
    }
  };

  const busy = phase.kind === 'cloning';

  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        fullWidth
        onClick={() => void handleClick()}
        disabled={busy}
        busy={busy}
        busyLabel={t('cloning')}
        className="text-[12px] uppercase tracking-[0.18em]"
      >
        <Pencil className="size-3.5" aria-hidden />
        {t('editInBuilder')}
      </Button>
      {phase.kind === 'failed' ? (
        <div className="rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 px-3 py-2">
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 size-3.5 shrink-0 text-[color:var(--danger)]"
              aria-hidden
            />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-[12px] text-[color:var(--fg-strong)]">
                {phase.message}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
