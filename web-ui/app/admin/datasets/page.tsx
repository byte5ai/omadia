'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  deleteDataset,
  getDataset,
  getDatasetRows,
  listDatasets,
  uploadDataset,
  type DatasetRowsResult,
  type DatasetSummary,
  type DatasetUploadResult,
} from '../../_lib/api';

/**
 * Admin → Knowledge · Datasets (issue #532).
 *
 * The web-ui face of the #430 CSV-import path: upload a CSV, browse the
 * inferred schema + a row preview, and delete. The REST surface
 * (`/bot-api/v1/datasets*`, cookie-session auth, owner-scoped) already exists
 * and is tested server-side (middleware/test/datasetsRoute.test.ts); this page
 * wires routing, an API client, and i18n.
 *
 * Scope note: the list is owner-scoped — it shows only datasets the current
 * user owns, NOT every dataset in the instance. CSVs other users imported from
 * chat attachments are stored under their own owner id and are not shown here
 * (see the intro copy and the /admin index card).
 *
 * The upload surfaces the mandatory privacy-scan and truncation stats returned
 * by the ingest pipeline — the whole point of #430 is that CSVs are scanned for
 * PII before they land in the graph, so the operator sees what was masked.
 */

const ROWS_PAGE_SIZE = 25;
const LIST_PAGE_SIZE = 50;

// Match the admin table idiom (app/admin/users, app/admin/mcp): a bordered
// `overflow-x-auto` wrapper, a faint `bg-card/40` head, `px-4 py-3` cells and
// subtle `border-t` row separators. (A global `tbody tr:hover` fill from
// globals.css still applies — these utility classes just add nothing on top.)
const TABLE_WRAP =
  'overflow-x-auto rounded-lg border border-[color:var(--border)]';
const TH_CLS =
  'px-4 py-3 text-left text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--fg-muted)]';
const TD_CLS = 'px-4 py-3 text-sm align-top';
const ROW_CLS = 'border-t border-[color:var(--border)]/50';
// Neutral type pill for the schema table — the inline-span badge idiom shared
// across admin pages (users status, duplicates status).
const TYPE_BADGE =
  'inline-flex items-center rounded-full bg-[color:var(--border)]/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]';
// Pagination controls need a ≥24px hit target (WCAG 2.5.8); the `-mx-2` keeps
// the visual position while the padding grows the target.
const PAGER_BTN =
  '-mx-2 px-2 py-1 text-xs hover:text-[color:var(--fg-strong)] disabled:opacity-40';

// The known middleware error codes we render as friendly, per-code copy; every
// other code falls back to the generic `errorByCode` line.
const KNOWN_ERROR_CODES = new Set([
  'limit_file_size',
  'unsupported_type',
  'import_failed',
  'not_found',
]);

/**
 * The middleware answers every dataset error as a structured `{ code, message }`
 * JSON body (never an HTML error page). Return the `dataset.`-stripped code so
 * the caller can map it to a catalog key; null when the error isn't an ApiError
 * (e.g. a network `TypeError`) or carries no code.
 */
function datasetErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(err.body) as { code?: string };
    if (typeof parsed.code !== 'string') return null;
    return parsed.code.replace(/^dataset\./, '');
  } catch {
    return null;
  }
}

export default function AdminDatasetsPage(): React.ReactElement {
  const t = useTranslations('adminDatasets');
  const format = useFormatter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  // Monotonic generation counter: every detail fetch captures the current value
  // and bails after its await if a newer fetch has since started, so a slow
  // response can never overwrite a fresher dataset's rows (schema/row mismatch).
  const detailSeq = useRef(0);

  const [items, setItems] = useState<DatasetSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [listOffset, setListOffset] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<DatasetUploadResult | null>(
    null,
  );

  const [selected, setSelected] = useState<DatasetSummary | null>(null);
  const [rows, setRows] = useState<DatasetRowsResult | null>(null);
  const [rowsOffset, setRowsOffset] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** Turn an error into a user-facing string via its structured code. */
  const errorMessage = useCallback(
    (err: unknown): string => {
      const code = datasetErrorCode(err);
      if (code !== null) {
        return KNOWN_ERROR_CODES.has(code)
          ? t(`errorCode.${code}`)
          : t('errorByCode', { code });
      }
      return err instanceof Error ? err.message : String(err);
    },
    [t],
  );

  const reload = useCallback(
    async (offset = 0): Promise<void> => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await listDatasets({ limit: LIST_PAGE_SIZE, offset });
        setItems(res.items);
        setTotal(res.total);
        setListOffset(res.offset);
      } catch (err) {
        setLoadError(errorMessage(err));
        setItems(null);
      } finally {
        setLoading(false);
      }
    },
    [errorMessage],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  // Move the opening panel into view once it has actually mounted — it otherwise
  // sits below the upload section and the whole list, off-screen on a long list.
  // Scrolling inside openDetail would fire before the panel renders (ref null on
  // the first open), so key it on the mount instead.
  useEffect(() => {
    if (openingId !== null && typeof detailRef.current?.scrollIntoView === 'function') {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [openingId]);

  const onUpload = useCallback(async (): Promise<void> => {
    if (file === null) return;
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const result = await uploadDataset(file, name);
      setUploadResult(result);
      setFile(null);
      setName('');
      setNameTouched(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
      await reload();
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }, [file, name, reload, errorMessage]);

  const openDetail = useCallback(
    async (ds: DatasetSummary): Promise<void> => {
      const my = ++detailSeq.current;
      setDetailError(null);
      setRows(null);
      setRowsOffset(0);
      setSelected(null);
      setOpeningId(ds.id);
      setRowsLoading(true);
      try {
        const [detail, firstRows] = await Promise.all([
          getDataset(ds.id),
          getDatasetRows(ds.id, { limit: ROWS_PAGE_SIZE, offset: 0 }),
        ]);
        if (my !== detailSeq.current) return;
        setSelected(detail);
        setRows(firstRows);
      } catch (err) {
        if (my !== detailSeq.current) return;
        setSelected(null);
        setDetailError(errorMessage(err));
      } finally {
        if (my === detailSeq.current) {
          setRowsLoading(false);
          setOpeningId(null);
        }
      }
    },
    [errorMessage],
  );

  const loadRowsPage = useCallback(
    async (offset: number): Promise<void> => {
      if (selected === null) return;
      const my = ++detailSeq.current;
      setDetailError(null);
      setRowsLoading(true);
      try {
        const page = await getDatasetRows(selected.id, {
          limit: ROWS_PAGE_SIZE,
          offset,
        });
        if (my !== detailSeq.current) return;
        setRows(page);
        setRowsOffset(offset);
      } catch (err) {
        if (my !== detailSeq.current) return;
        setDetailError(errorMessage(err));
      } finally {
        if (my === detailSeq.current) setRowsLoading(false);
      }
    },
    [selected, errorMessage],
  );

  const closeDetail = useCallback((): void => {
    // Invalidate any in-flight fetch so it can't reopen the panel after close.
    detailSeq.current += 1;
    setSelected(null);
    setRows(null);
    setDetailError(null);
    setOpeningId(null);
  }, []);

  const onDelete = useCallback(
    async (id: string): Promise<void> => {
      setDeleting(id);
      setDeleteError(null);
      try {
        await deleteDataset(id);
        if (selected?.id === id) closeDetail();
        setConfirmDelete(null);
        // If we just removed the last row of a non-first page, step back so the
        // operator doesn't land on an empty page.
        const stepBack =
          items !== null && items.length === 1 && listOffset > 0;
        await reload(stepBack ? Math.max(0, listOffset - LIST_PAGE_SIZE) : listOffset);
      } catch (err) {
        // A failed delete is a delete error, not a load error — and reload() so
        // the table reflects reality (the row may already be gone). Leave
        // confirmDelete armed so a retry doesn't restart the two-click guard.
        setDeleteError(errorMessage(err));
        await reload(listOffset);
      } finally {
        setDeleting(null);
      }
    },
    [selected, items, listOffset, reload, closeDetail, errorMessage],
  );

  const rowsShown = rows?.rows ?? [];
  const listFrom = total === 0 ? 0 : listOffset + 1;
  const listTo = listOffset + (items?.length ?? 0);

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </header>

      {/* Upload */}
      <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('upload.heading')}
        </h2>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              disabled={uploading}
              aria-label={t('upload.fileLabel')}
              onChange={(e) => {
                const next = e.target.files?.[0] ?? null;
                setFile(next);
                setUploadError(null);
                setUploadResult(null);
                // Re-derive the name from the file on every change until the
                // operator has typed their own, so replacing the file can't
                // leave a stale name from the previous one.
                if (next !== null && !nameTouched) {
                  setName(next.name.replace(/\.csv$/i, ''));
                }
              }}
              className="rounded-md text-sm text-[color:var(--fg-strong)] file:mr-3 file:rounded-md file:border file:border-[color:var(--border)] file:bg-[color:var(--card)] file:px-3 file:py-1.5 file:text-sm file:text-[color:var(--fg-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
            />
            <span className="text-xs text-[color:var(--fg-muted)]">
              {t('upload.fileHint')}
            </span>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[color:var(--fg-muted)]">
              {t('upload.nameLabel')}
            </span>
            <input
              type="text"
              value={name}
              disabled={uploading}
              placeholder={t('upload.namePlaceholder')}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-[color:var(--fg-strong)]"
            />
          </label>
          <div className="flex items-center justify-end">
            <Button
              variant="primary"
              onClick={() => void onUpload()}
              disabled={file === null}
              busy={uploading}
              busyLabel={t('upload.uploading')}
            >
              {t('upload.submit')}
            </Button>
          </div>
        </div>

        {uploadError !== null && (
          <div className="mt-3 rounded-md border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]">
            {t('uploadError', { message: uploadError })}
          </div>
        )}

        {uploadResult !== null && (
          <div className="mt-3 rounded-md border border-[color:var(--success)]/40 bg-[color:var(--success)]/8 p-3 text-sm text-[color:var(--fg-strong)]">
            <p className="font-medium">
              {t('upload.success', {
                rows: uploadResult.dataset.rowCount,
              })}
            </p>
            <p className="mt-1 text-[color:var(--fg-muted)]">
              {t('upload.privacyScan', {
                scanned: uploadResult.privacyScan.scannedCells,
                masked: uploadResult.privacyScan.maskedCells,
              })}
            </p>
            {uploadResult.truncation.truncatedCellCount > 0 && (
              <p className="mt-1 text-[color:var(--warning)]">
                {t('upload.truncation', {
                  cells: uploadResult.truncation.truncatedCellCount,
                  columns:
                    uploadResult.truncation.truncatedColumns.join(', '),
                })}
              </p>
            )}
          </div>
        )}
      </section>

      {/* List */}
      <section className="mb-6">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('list.heading')}
        </h2>

        {loading && (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
        )}

        {loadError !== null && (
          <div className="rounded-lg border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/10 px-4 py-3 text-sm text-[color:var(--danger)]">
            {t('loadError', { message: loadError })}
          </div>
        )}

        {deleteError !== null && (
          <div className="mb-3 rounded-lg border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/10 px-4 py-3 text-sm text-[color:var(--danger)]">
            {t('list.deleteFailed', { message: deleteError })}
          </div>
        )}

        {items !== null && !loading && items.length === 0 && (
          <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-6 text-center text-sm text-[color:var(--fg-muted)]">
            {t('empty')}
          </div>
        )}

        {items !== null && items.length > 0 && (
          <>
            <div className={TABLE_WRAP}>
              <table className="w-full text-left text-sm">
                <thead className="bg-[color:var(--card)]/40">
                  <tr>
                    <th className={TH_CLS}>{t('list.colName')}</th>
                    <th className={TH_CLS}>{t('list.colRows')}</th>
                    <th className={TH_CLS}>{t('list.colColumns')}</th>
                    <th className={TH_CLS}>{t('list.colCreated')}</th>
                    <th className={`${TH_CLS} text-right`}>
                      {t('list.colActions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((ds) => (
                    <tr key={ds.id} className={ROW_CLS}>
                      <td className={TD_CLS}>
                        {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare cell text, no border/bg) */}
                        <button
                          type="button"
                          onClick={() => void openDetail(ds)}
                          disabled={openingId !== null}
                          aria-busy={openingId === ds.id}
                          className="text-left font-medium text-[color:var(--fg-strong)] hover:text-[color:var(--accent)] disabled:opacity-50"
                        >
                          {ds.name}
                        </button>
                      </td>
                      <td className={`${TD_CLS} font-mono text-[color:var(--fg-muted)]`}>
                        {format.number(ds.rowCount)}
                      </td>
                      <td className={`${TD_CLS} font-mono text-[color:var(--fg-muted)]`}>
                        {ds.columns.length}
                      </td>
                      <td className={`${TD_CLS} text-[color:var(--fg-muted)]`}>
                        {format.dateTime(new Date(ds.createdAt), {
                          dateStyle: 'medium',
                        })}
                      </td>
                      <td className={`${TD_CLS} text-right`}>
                        {confirmDelete === ds.id ? (
                          <span className="inline-flex items-center justify-end gap-2">
                            <Button
                              variant="danger"
                              size="sm"
                              autoFocus
                              onClick={() => void onDelete(ds.id)}
                              busy={deleting === ds.id}
                              busyLabel={t('list.deleting')}
                              aria-label={t('list.confirmDeleteAria', {
                                name: ds.name,
                              })}
                            >
                              {t('list.confirmDelete')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmDelete(null)}
                              disabled={deleting === ds.id}
                            >
                              {t('list.cancel')}
                            </Button>
                          </span>
                        ) : (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              setConfirmDelete(ds.id);
                              setDeleteError(null);
                            }}
                            aria-label={t('list.deleteAria', { name: ds.name })}
                          >
                            {t('list.delete')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-[color:var(--fg-muted)]">
              <span>
                {t('list.showing', {
                  from: listFrom,
                  to: listTo,
                  total,
                })}
              </span>
              <span className="inline-flex gap-2">
                {/* eslint-disable-next-line no-restricted-syntax -- pager chrome (bare text, no border/bg) */}
                <button
                  type="button"
                  disabled={listOffset === 0 || loading}
                  onClick={() =>
                    void reload(Math.max(0, listOffset - LIST_PAGE_SIZE))
                  }
                  className={PAGER_BTN}
                >
                  {t('list.prev')}
                </button>
                {/* eslint-disable-next-line no-restricted-syntax -- pager chrome (bare text, no border/bg) */}
                <button
                  type="button"
                  disabled={listTo >= total || loading}
                  onClick={() => void reload(listOffset + LIST_PAGE_SIZE)}
                  className={PAGER_BTN}
                >
                  {t('list.next')}
                </button>
              </span>
            </div>
          </>
        )}
      </section>

      {/* Detail: schema + row preview */}
      {detailError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {t('detailError', { message: detailError })}
        </section>
      )}

      {(selected !== null || openingId !== null) && (
        <section
          ref={detailRef}
          className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
        >
          {selected === null ? (
            <p className="text-sm text-[color:var(--fg-muted)]" aria-busy>
              {t('loading')}
            </p>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-[color:var(--fg-strong)]">
                  {t('detail.heading', { name: selected.name })}
                </h2>
                {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare muted text, no border/bg) */}
                <button
                  type="button"
                  onClick={closeDetail}
                  className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
                >
                  {t('detail.close')}
                </button>
              </div>

              {/* Schema */}
              <h3 className="mb-2 text-xs font-medium text-[color:var(--fg-muted)]">
                {t('detail.schemaHeading')}
              </h3>
              <div className={`mb-4 ${TABLE_WRAP}`}>
                <table className="w-full text-left text-sm">
                  <thead className="bg-[color:var(--card)]/40">
                    <tr>
                      <th className={TH_CLS}>{t('detail.colColumn')}</th>
                      <th className={TH_CLS}>{t('detail.colType')}</th>
                      <th className={TH_CLS}>{t('detail.colSample')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.columns.map((col) => (
                      <tr key={col.name} className={ROW_CLS}>
                        <td className={`${TD_CLS} font-mono`}>{col.name}</td>
                        <td className={TD_CLS}>
                          <span className={TYPE_BADGE}>{col.type}</span>
                        </td>
                        <td className={`${TD_CLS} text-[color:var(--fg-muted)]`}>
                          {col.sample ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Row preview */}
              <h3 className="mb-2 text-xs font-medium text-[color:var(--fg-muted)]">
                {t('detail.rowsHeading')}
              </h3>
              {rows !== null && rowsShown.length > 0 ? (
                <>
                  <div className={TABLE_WRAP}>
                    <table className="w-full text-left text-sm">
                      <thead className="bg-[color:var(--card)]/40">
                        <tr>
                          {selected.columns.map((col) => (
                            <th key={col.name} className={TH_CLS}>
                              {col.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rowsShown.map((row, i) => (
                          <tr key={i} className={ROW_CLS}>
                            {selected.columns.map((col) => (
                              <td
                                key={col.name}
                                className={`${TD_CLS} font-mono text-[color:var(--fg-muted)]`}
                              >
                                {/* The ingest cap is MAX_CELL_CHARS = 4000, so a
                                    single unbreakable value would otherwise
                                    stretch the row past every other column and
                                    the preview stops being a preview. Same
                                    clamp idiom as the admin JobTable. */}
                                <div
                                  className="max-w-[40ch] truncate"
                                  title={String(row[col.name] ?? '')}
                                >
                                  {String(row[col.name] ?? '')}
                                </div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs text-[color:var(--fg-muted)]">
                    <span>
                      {t('detail.rowsShowing', {
                        from: rowsOffset + 1,
                        to: rowsOffset + rowsShown.length,
                        total: rows.totalMatched,
                      })}
                    </span>
                    <span className="inline-flex gap-2">
                      {/* eslint-disable-next-line no-restricted-syntax -- pager chrome (bare text, no border/bg) */}
                      <button
                        type="button"
                        disabled={rowsOffset === 0 || rowsLoading}
                        onClick={() =>
                          void loadRowsPage(
                            Math.max(0, rowsOffset - ROWS_PAGE_SIZE),
                          )
                        }
                        className={PAGER_BTN}
                      >
                        {t('detail.prev')}
                      </button>
                      {/* eslint-disable-next-line no-restricted-syntax -- pager chrome (bare text, no border/bg) */}
                      <button
                        type="button"
                        disabled={
                          rowsOffset + rowsShown.length >= rows.totalMatched ||
                          rowsLoading
                        }
                        onClick={() =>
                          void loadRowsPage(rowsOffset + ROWS_PAGE_SIZE)
                        }
                        className={PAGER_BTN}
                      >
                        {t('detail.next')}
                      </button>
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-sm text-[color:var(--fg-muted)]">
                  {rowsLoading ? t('loading') : t('detail.noRows')}
                </p>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
