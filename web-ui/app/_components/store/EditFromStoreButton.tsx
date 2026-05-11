'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2, Pencil } from 'lucide-react';

import { cloneBuilderDraftFromInstalled } from '../../_lib/api';
import { cn } from '../../_lib/cn';
import type { CloneFromInstalledResponse } from '../../_lib/builderTypes';

/**
 * Edit-from-Store action (B.6-3). Surfaces on the plugin detail page when
 * the agent is currently installed; POSTs to
 * `/api/v1/builder/drafts/from-installed/:agentId` and on success
 * redirects the operator to the cloned draft's workspace.
 *
 * Failure modes (typed via `CloneFromInstalledFailureReason`):
 *   source_not_found  → inline message ("Original-Draft nicht mehr
 *                       verfügbar — Reverse-Codegen kommt erst in B.7")
 *   quota_exceeded    → inline message ("Draft-Quota erreicht — lösche
 *                       bestehende Drafts")
 *
 * Per Open Question #4 (Edit-from-Store-State = clone): the installed
 * plugin stays live during edit. The new draft has no `installed_agent_id`
 * link; re-install routes through the install-commit flow with a
 * Conflict-Detection check on `id`/`version`.
 */

export interface EditFromStoreButtonProps {
  installedAgentId: string;
  /** Optional override for tests — defaults to the real api fn. */
  clone?: (agentId: string) => Promise<CloneFromInstalledResponse>;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'cloning' }
  | { kind: 'failed'; message: string; hint: string | null };

export function EditFromStoreButton({
  installedAgentId,
  clone,
}: EditFromStoreButtonProps): React.ReactElement {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const handleClick = async (): Promise<void> => {
    setPhase({ kind: 'cloning' });
    try {
      const fn = clone ?? cloneBuilderDraftFromInstalled;
      const result = await fn(installedAgentId);
      if (result.ok) {
        router.push(`/store/builder/${encodeURIComponent(result.draftId)}`);
        return;
      }
      setPhase({
        kind: 'failed',
        message: result.message,
        hint: HINTS[result.reason] ?? null,
      });
    } catch (err) {
      setPhase({
        kind: 'failed',
        message: err instanceof Error ? err.message : String(err),
        hint: null,
      });
    }
  };

  const busy = phase.kind === 'cloning';

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={busy}
        className={cn(
          'inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2',
          'text-[12px] font-semibold uppercase tracking-[0.18em]',
          'border border-[color:var(--rule-strong)] bg-[color:var(--paper)] text-[color:var(--ink)]',
          'transition-colors hover:bg-[color:var(--bg-soft)]',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        {busy ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Klone Draft …
          </>
        ) : (
          <>
            <Pencil className="size-3.5" aria-hidden />
            Im Builder bearbeiten
          </>
        )}
      </button>
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
              {phase.hint ? (
                <p className="text-[11px] italic text-[color:var(--fg-muted)]">
                  {phase.hint}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const HINTS: Partial<Record<'source_not_found' | 'quota_exceeded', string>> = {
  source_not_found:
    'Der Original-Draft des Builders existiert nicht mehr (gelöscht oder von einem anderen Operator installiert). Reverse-Codegen aus der installierten manifest.yaml kommt erst in B.7.',
  quota_exceeded:
    'Lösch bestehende Drafts unter „Drafts", bevor du diesen klonst.',
};
