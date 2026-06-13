'use client';

import { useCallback, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';

import { ApiError, createBuilderDraft } from '../../../_lib/api';
import type { DraftQuotaSnapshot } from '../../../_lib/builderTypes';
import { Button } from '@/app/_components/ui/Button';

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
  const t = useTranslations('builder.drafts.create');
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
      <Button
        variant="primary"
        pill
        onClick={onClick}
        disabled={disabled}
        title={quota.exceeded ? t('quotaReachedTooltip') : undefined}
      >
        <Plus className="size-4" aria-hidden />
        {pending ? t('pending') : t('label')}
      </Button>
      {error ? (
        <p className="max-w-xs text-right text-[11px] text-[color:var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
