'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { ConfirmDialog } from '@/app/_components/ConfirmDialog';
import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  type FieldBulkBatch,
  type FieldBulkFilter,
  type FieldBulkItem,
  type FieldBulkPreview,
  type FieldBulkResult,
  type FieldBulkSkip,
  type FieldBulkUndoResult,
  confirmFieldBulk,
  previewFieldBulkConfirm,
  undoFieldBulk,
} from '../../../_lib/api';
import { serverErrorMessage } from '../../../_lib/apiErrorMessage';
import { ErrorLine } from './FieldCard';
import { formatWhen } from './fieldText';

/**
 * Bulk accept on `/admin/privacy-fields`: a confirm dialog fed by
 * `bulk/preview` (count, breakdown by reason and tool, the field keys), the
 * result summary (applied / skipped with localized reasons), and undo of the
 * latest bulk action. The server re-validates every field on confirm.
 */

/** Skip reasons with a catalog sentence; anything else renders `unknown`. */
const KNOWN_SKIP_REASONS = new Set([
  'not_suggested',
  'person_model',
  'detector_hit',
  'conflict',
  'no_scope',
  'invalid_field',
  'already_covered',
  'stale',
  'not_present',
  'not_owned',
]);

const KNOWN_BASIS_CODES = new Set(['known_non_personal', 'haiku']);

/** Localized text for a skip reason code. */
export function skipReasonText(reason: string, t: ReturnType<typeof useTranslations>): string {
  return KNOWN_SKIP_REASONS.has(reason)
    ? t(`bulk.skip.${reason}`)
    : t('bulk.skip.unknown', { code: reason });
}

function basisText(code: string, t: ReturnType<typeof useTranslations>): string {
  return KNOWN_BASIS_CODES.has(code) ? t(`bulk.basis.${code}`) : t('bulk.basis.unknown', { code });
}

/** Records in codepoint order, so the breakdown is stable. */
function sortedEntries(record: Record<string, number>): [string, number][] {
  return Object.entries(record)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; preview: FieldBulkPreview }
  | { kind: 'error'; detail: string | null };

/** The request body of a confirm: the exact fields shown when the preview
 *  listed all of them, the filter otherwise. */
export function bulkTarget(
  filter: FieldBulkFilter,
  preview: FieldBulkPreview,
): { ids: string[] } | { filter: FieldBulkFilter } {
  return preview.items.length === preview.count && preview.count > 0
    ? { ids: preview.items.map((i) => i.id) }
    : { filter };
}

export function BulkAcceptDialog({
  filter,
  onCancel,
  onDone,
}: {
  filter: FieldBulkFilter;
  onCancel: () => void;
  /** Called with the server result and the previewed items (for names). */
  onDone: (result: FieldBulkResult, items: readonly FieldBulkItem[]) => void;
}): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  const format = useFormatter();
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const preview = await previewFieldBulkConfirm(filter);
        if (!cancelled) setState({ kind: 'ready', preview });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', detail: serverErrorMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter]);

  const preview = state.kind === 'ready' ? state.preview : null;

  const confirm = async (): Promise<void> => {
    if (preview === null || preview.count === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await confirmFieldBulk(bulkTarget(filter, preview));
      onDone(result, preview.items);
    } catch (err) {
      setError(serverErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      wide
      title={filter.tool ? t('bulk.dialogTitleTool', { tool: filter.tool }) : t('bulk.dialogTitle')}
      body={t('bulk.dialogBody')}
      confirmLabel={
        preview !== null ? t('bulk.confirm', { count: preview.count }) : t('bulk.confirmPending')
      }
      cancelLabel={t('bulk.cancel')}
      busy={busy}
      busyLabel={t('bulk.applying')}
      confirmDisabled={preview === null || preview.count === 0}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    >
      <div className="mt-3 text-[13px]" data-testid="bulk-dialog-content">
        {state.kind === 'loading' ? (
          <p className="opacity-70">{t('bulk.loadingPreview')}</p>
        ) : state.kind === 'error' ? (
          <ErrorLine message={t('errors.bulkPreview')} detail={state.detail} />
        ) : state.preview.count === 0 ? (
          <p data-testid="bulk-empty">{t('bulk.nothingEligible')}</p>
        ) : (
          <PreviewContent preview={state.preview} format={format} />
        )}
        {error !== undefined ? <ErrorLine message={t('errors.bulkConfirm')} detail={error} /> : null}
      </div>
    </ConfirmDialog>
  );
}

function PreviewContent({
  preview,
  format,
}: {
  preview: FieldBulkPreview;
  format: ReturnType<typeof useFormatter>;
}): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  const byReason = sortedEntries(preview.byReason);
  const byTool = sortedEntries(preview.byTool);
  return (
    <>
      <p className="font-semibold text-[color:var(--fg-strong)]" data-testid="bulk-count">
        {t('bulk.count', { count: preview.count })}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <section aria-labelledby="bulk-by-reason">
          <h3 id="bulk-by-reason" className="text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('bulk.byReason')}
          </h3>
          <ul className="mt-1" data-testid="bulk-by-reason">
            {byReason.map(([code, n]) => (
              <li key={code}>
                {basisText(code, t)}: <span className="font-semibold">{format.number(n)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="bulk-by-tool">
          <h3 id="bulk-by-tool" className="text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('bulk.byTool')}
          </h3>
          <ul className="mt-1" data-testid="bulk-by-tool">
            {byTool.map(([tool, n]) => (
              <li key={tool}>
                <span className="font-mono">{tool}</span>:{' '}
                <span className="font-semibold">{format.number(n)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <h3 className="mt-3 text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
        {t('bulk.fieldsHeading')}
      </h3>
      <ul
        tabIndex={0}
        aria-label={t('bulk.fieldsHeading')}
        data-testid="bulk-field-list"
        className="mt-1 max-h-60 overflow-y-auto rounded-md border border-[color:var(--border)] p-2 font-mono text-[12px]"
      >
        {preview.items.map((item) => (
          <li key={item.id}>{item.entry}</li>
        ))}
      </ul>
      {preview.items.length < preview.count ? (
        <p className="mt-1 text-xs text-[color:var(--fg-muted)]">
          {t('bulk.moreNotListed', { count: preview.count - preview.items.length })}
        </p>
      ) : null}
    </>
  );
}

/** Skipped fields, named by their entry when known. */
function SkippedList({
  skipped,
  names,
}: {
  skipped: readonly FieldBulkSkip[];
  names: ReadonlyMap<string, string>;
}): React.ReactElement | null {
  const t = useTranslations('adminPrivacyFields');
  if (skipped.length === 0) return null;
  return (
    <>
      <p className="mt-1">{t('bulk.skippedHeading', { count: skipped.length })}</p>
      <ul className="mt-1 list-disc pl-5" data-testid="bulk-skipped">
        {skipped.map((s) => (
          <li key={s.id}>
            <span className="font-mono">{names.get(s.id) ?? s.id}</span>: {skipReasonText(s.reason, t)}
          </li>
        ))}
      </ul>
    </>
  );
}

export function BulkResultSummary({
  result,
  items,
}: {
  result: FieldBulkResult;
  items: readonly FieldBulkItem[];
}): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  const names = new Map(items.map((i) => [i.id, i.entry]));
  return (
    <div role="status" data-testid="bulk-result" className="mb-4 rounded-md border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 px-3 py-2 text-[13px]">
      <p className="font-semibold">{t('bulk.applied', { count: result.applied.length })}</p>
      <SkippedList skipped={result.skipped} names={names} />
      {result.remaining > 0 ? <p className="mt-1">{t('bulk.remaining', { count: result.remaining })}</p> : null}
    </div>
  );
}

/** "Undo last bulk action": confirm, POST undo, summary. */
export function UndoBulk({
  batch,
  onUndone,
}: {
  batch: FieldBulkBatch;
  onUndone: (result: FieldBulkUndoResult) => void;
}): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail: string | null } | null>(null);
  const when = formatWhen(batch.createdAt, format);

  const undo = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await undoFieldBulk(batch.id);
      setOpen(false);
      onUndone(result);
    } catch (err) {
      const code = err instanceof ApiError && err.status === 409 ? err.code : null;
      setError({
        message:
          code === 'not_latest_batch' || code === 'already_undone'
            ? t(`errors.${code === 'not_latest_batch' ? 'undoNotLatest' : 'undoAlreadyUndone'}`)
            : t('errors.undo'),
        detail: serverErrorMessage(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        data-testid="bulk-undo"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t('bulk.undo')}
      </Button>
      <ConfirmDialog
        open={open}
        title={t('bulk.undoTitle')}
        body={
          when !== null
            ? t('bulk.undoBody', { count: batch.count, when })
            : t('bulk.undoBodyNoDate', { count: batch.count })
        }
        confirmLabel={t('bulk.undoConfirm')}
        cancelLabel={t('bulk.cancel')}
        tone="danger"
        busy={busy}
        busyLabel={t('bulk.undoing')}
        onCancel={() => setOpen(false)}
        onConfirm={() => void undo()}
      >
        {error !== null ? <ErrorLine message={error.message} detail={error.detail} /> : null}
      </ConfirmDialog>
    </>
  );
}

export function UndoResultSummary({ result }: { result: FieldBulkUndoResult }): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  const names = new Map(result.reverted.map((i) => [i.id, i.entry]));
  return (
    <div role="status" data-testid="bulk-undo-result" className="mb-4 rounded-md border border-[color:var(--border)] px-3 py-2 text-[13px]">
      <p className="font-semibold">{t('bulk.undone', { count: result.reverted.length })}</p>
      <SkippedList skipped={result.skipped} names={names} />
    </div>
  );
}
