'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Download } from 'lucide-react';

import { ApiError, captureSnapshot, snapshotDownloadUrl } from '../../../_lib/api';
import { cn } from '../../../_lib/cn';

type ExportFormat = 'plugin' | 'bundle';

export interface ExportDraftButtonProps {
  /** Draft id — equal to the backing `profile_id` (draft_id == profile_id). */
  draftId: string;
  /** Optional override for tests — defaults to the real api fn. */
  capture?: typeof captureSnapshot;
  /**
   * Optional override for tests — performs the actual browser navigation
   * that streams the ZIP. Defaults to `window.location.assign`.
   */
  onDownload?: (url: string) => void;
}

/**
 * One-click export of a published builder draft from the dashboard card
 * (#270). Opening the menu and picking a format is at most two clicks and
 * never opens the builder editor.
 *
 * The download endpoint is keyed on a snapshot, so we `captureSnapshot`
 * first. That call is content-addressed in the middleware
 * (`createSnapshot` dedupes by `bundle_hash`): when the draft is unchanged
 * it returns the existing snapshot with `was_existing: true` and creates
 * **no** phantom snapshot row — satisfying the "no phantom snapshot"
 * acceptance criterion. When the draft has diverged since the last
 * snapshot, a fresh one capturing the current state is created silently.
 */
export function ExportDraftButton({
  draftId,
  capture,
  onDownload,
}: ExportDraftButtonProps): React.ReactElement {
  const t = useTranslations('builder.drafts.row.export');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onExport = useCallback(
    async (format: ExportFormat): Promise<void> => {
      setOpen(false);
      setError(null);
      setBusy(true);
      try {
        const captureFn = capture ?? captureSnapshot;
        const snapshot = await captureFn(draftId);
        const base = snapshotDownloadUrl(draftId, snapshot.snapshot_id);
        const url = format === 'bundle' ? `${base}?format=bundle` : base;
        const navigate =
          onDownload ?? ((target: string): void => window.location.assign(target));
        navigate(url);
      } catch (err) {
        setError(humanizeError(err));
      } finally {
        setBusy(false);
      }
    },
    [capture, draftId, onDownload],
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('label')}
        className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--fg-muted)] transition-colors hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)] disabled:opacity-50"
      >
        {busy ? (
          <span className="lume-busy-dots" aria-hidden />
        ) : (
          <Download className="size-3.5" aria-hidden />
        )}
        {busy ? t('preparing') : t('label')}
        {!busy && <ChevronDown className="size-3" aria-hidden />}
      </button>

      {open && !busy ? (
        <>
          {/* Click-outside backdrop. */}
          <div
            className="fixed inset-0 z-10"
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            aria-label={t('menuLabel')}
            className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-[color:var(--divider)] bg-[color:var(--bg-elevated)] py-1 shadow-[0_6px_20px_rgba(0,75,115,0.12)]"
          >
            <ExportMenuItem
              label={t('plugin')}
              hint={t('pluginHint')}
              onClick={() => void onExport('plugin')}
            />
            <ExportMenuItem
              label={t('bundle')}
              hint={t('bundleHint')}
              onClick={() => void onExport('bundle')}
            />
          </div>
        </>
      ) : null}

      {error ? (
        <p className="absolute right-0 mt-1 whitespace-nowrap text-[11px] text-[color:var(--danger)]">
          {t('failed', { message: error })}
        </p>
      ) : null}
    </div>
  );
}

function ExportMenuItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left',
        'hover:bg-[color:var(--bg-soft)]',
      )}
    >
      <span className="text-[12px] font-semibold text-[color:var(--fg-strong)]">
        {label}
      </span>
      <span className="text-[10px] text-[color:var(--fg-muted)]">{hint}</span>
    </button>
  );
}

function humanizeError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { message?: string };
      return body.message ?? err.message;
    } catch {
      return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
