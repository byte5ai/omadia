'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';

import { cn } from '../../_lib/cn';
import { deleteUploadedPackage } from '../../_lib/api';
import { Button } from '@/app/_components/ui/Button';
import { useStoreErrorText } from './useStoreErrorText';

/**
 * #1490 — remove an uploaded (or Hub-fetched) package that is NOT installed.
 *
 * The API had the route all along (`DELETE /install/packages/:id`), and the
 * duplicate-version message told the operator to remove the upload, but the
 * only caller was the uninstall dialog, which an uninstalled plugin never
 * shows. Rendered by the install button when the store response flags the
 * plugin `removable_package`.
 */
export function RemovePackageAction({
  pluginId,
  pluginName,
}: {
  pluginId: string;
  pluginName: string;
}): React.ReactElement {
  const t = useTranslations('store.install');
  const router = useRouter();
  const errorText = useStoreErrorText();
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'confirming' }
    | { kind: 'working' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function doRemove(): Promise<void> {
    setState({ kind: 'working' });
    try {
      await deleteUploadedPackage(pluginId);
      // The detail page of a removed package no longer exists (a Hub plugin
      // resolves again, as Hub-only) — back to the overview, same as the
      // uninstall dialog does after removing the package.
      router.push('/store');
      router.refresh();
    } catch (err) {
      setState({ kind: 'error', message: errorText(err) });
    }
  }

  if (state.kind === 'idle') {
    return (
      // eslint-disable-next-line no-restricted-syntax -- inline text link (bare text + icon, no border/bg)
      <button
        type="button"
        onClick={() => setState({ kind: 'confirming' })}
        className={cn(
          'inline-flex items-center gap-2 text-[12px] font-semibold',
          'text-[color:var(--fg-muted)] transition hover:text-[color:var(--danger,#b03030)]',
        )}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {t('removePackage')}
      </button>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="rounded-md border border-[color:var(--danger,#b03030)]/40 bg-[color:var(--danger,#b03030)]/6 px-3 py-2">
        <p className="text-[12px] text-[color:var(--danger,#b03030)]">
          {t('removePackageFailed', { message: state.message })}
        </p>
        {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare text, no border/bg) */}
        <button
          type="button"
          onClick={() => setState({ kind: 'idle' })}
          className="mt-1 text-[11px] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)]"
        >
          {t('reset')}
        </button>
      </div>
    );
  }

  const working = state.kind === 'working';
  return (
    <div className="rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-3">
      <p className="text-[12px] leading-relaxed text-[color:var(--fg)]">
        {t.rich('removePackageConfirm', {
          name: pluginName,
          strong: (chunks) => <strong>{chunks}</strong>,
        })}
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          variant="danger"
          pill
          onClick={() => void doRemove()}
          disabled={working}
          busy={working}
          busyLabel={t('removingPackage')}
        >
          {t('removePackageYes')}
        </Button>
        <Button
          variant="secondary"
          pill
          size="sm"
          onClick={() => setState({ kind: 'idle' })}
          disabled={working}
          className="font-semibold text-[color:var(--fg-muted)]"
        >
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
