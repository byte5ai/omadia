'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { uninstallPlugin } from '../../_lib/api';
import { ConfirmDialog } from '../ConfirmDialog';
import { Button } from '../ui/Button';

/**
 * Uninstalls one installed entry whose package is gone. Such an entry has no
 * detail page (the store resolves pages through the catalogue), so this is
 * the only place the operator can remove it. Never automatic: one entry, one
 * confirmed click.
 */
export function RemovePackagelessEntryButton({ id }: { id: string }): React.ReactElement {
  const t = useTranslations('store.packageless');
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function remove(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      await uninstallPlugin(id);
      setAsking(false);
      router.refresh();
    } catch (err) {
      console.warn('uninstalling an entry without a package failed', err);
      setAsking(false);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        data-testid={`packageless-remove-${id}`}
        onClick={() => setAsking(true)}
      >
        {t('remove')}
      </Button>
      {failed ? (
        <span role="alert" className="text-[12px] text-[color:var(--danger)]">
          {t('removeFailed')}
        </span>
      ) : null}
      <ConfirmDialog
        open={asking}
        tone="danger"
        title={t('removeConfirmTitle', { id })}
        body={t('removeConfirmBody')}
        confirmLabel={t('remove')}
        cancelLabel={t('cancel')}
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setAsking(false)}
      />
    </>
  );
}
