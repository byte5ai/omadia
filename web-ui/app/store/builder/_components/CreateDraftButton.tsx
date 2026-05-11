'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

import { ApiError, createBuilderDraft } from '../../../_lib/api';
import type { DraftQuotaSnapshot } from '../../../_lib/builderTypes';
import { cn } from '../../../_lib/cn';

/**
 * Primary "neuer Agent"-Action. One click creates a draft row via POST
 * /builder/drafts and then refreshes the RSC tree so the new row appears at
 * the top of the list. Quota-exceeded (409) is rendered inline instead of
 * redirecting to a separate error page.
 */
export function CreateDraftButton({
  quota,
}: {
  quota: DraftQuotaSnapshot;
}): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const disabled = pending || quota.exceeded;

  const onClick = useCallback(() => {
    setError(null);
    startTransition(async () => {
      try {
        await createBuilderDraft();
        router.refresh();
      } catch (err) {
        if (err instanceof ApiError) {
          try {
            const body = JSON.parse(err.body) as { message?: string };
            setError(body.message ?? err.message);
          } catch {
            setError(err.message);
          }
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    });
  }, [router]);

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'inline-flex items-center gap-2 rounded-full px-5 py-2 text-[13px] font-semibold',
          'shadow-[var(--shadow-cta)] transition-transform duration-[var(--dur-base)]',
          'bg-[color:var(--accent)] text-white hover:-translate-y-0.5',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]',
          'disabled:translate-y-0 disabled:opacity-50 disabled:hover:translate-y-0',
        )}
        title={
          quota.exceeded
            ? 'Draft-Quota erreicht — lösche bestehende, bevor du einen neuen anlegst.'
            : undefined
        }
      >
        <Plus className="size-4" aria-hidden />
        {pending ? 'Wird angelegt…' : 'Neuer Agent'}
      </button>
      {error ? (
        <p className="max-w-xs text-right text-[11px] text-[color:var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
