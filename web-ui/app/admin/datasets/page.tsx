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
 * only wires routing, an API client, and i18n — the Phase-14 follow-up tracked
 * in docs/middleware-agent-handoff.md §13.
 *
 * The upload surfaces the mandatory privacy-scan and truncation stats returned
 * by the ingest pipeline — the whole point of #430 is that CSVs are scanned for
 * PII before they land in the graph, so the operator sees what was masked.
 */

const ROWS_PAGE_SIZE = 25;

// Match the admin table idiom (app/admin/users, app/admin/dev-platform): a
// bordered `overflow-x-auto` wrapper, a faint `bg-card/40` head, `px-4 py-3`
// cells and subtle `border-t` row separators — no per-row hover fill.
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

/**
 * The middleware answers every dataset error as a structured `{ code, message }`
 * JSON body (never an HTML error page). Map the known codes to a catalog key so
 * the user sees a friendly line; fall back to the raw message otherwise.
 */
function datasetErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed = JSON.parse(err.body) as { code?: string };
    return parsed.code ?? null;
  } catch {
    return null;
  }
}

export default function AdminDatasetsPage(): React.ReactElement {
  const t = useTranslations('adminDatasets');
  const format = useFormatter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [items, setItems] = useState<DatasetSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<DatasetUploadResult | null>(
    null,
  );

  const [selected, setSelected] = useState<DatasetSummary | null>(null);
  const [rows, setRows] = useState<DatasetRowsResult | null>(null);
  const [rowsOffset, setRowsOffset] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  /** Turn an error into a user-facing string via its structured code. */
  const errorMessage = useCallback(
    (err: unknown): string => {
      const code = datasetErrorCode(err);
      if (code !== null) return t('errorByCode', { code });
      return err instanceof Error ? err.message : String(err);
    },
    [t],
  );

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      setItems(await listDatasets());
    } catch (err) {
      setLoadError(errorMessage(err));
      setItems(null);
    } finally {
      setLoading(false);
    }
  }, [errorMessage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

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
      if (fileInputRef.current !== null) fileInputRef.current.value = '';
      await reload();
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }, [file, name, reload, errorMessage]);

  const openDetail = useCallback(
    async (id: string): Promise<void> => {
      setDetailError(null);
      setRows(null);
      setRowsOffset(0);
      setRowsLoading(true);
      try {
        const [detail, firstRows] = await Promise.all([
          getDataset(id),
          getDatasetRows(id, { limit: ROWS_PAGE_SIZE, offset: 0 }),
        ]);
        setSelected(detail);
        setRows(firstRows);
      } catch (err) {
        setSelected(null);
        setDetailError(errorMessage(err));
      } finally {
        setRowsLoading(false);
      }
    },
    [errorMessage],
  );

  const loadRowsPage = useCallback(
    async (offset: number): Promise<void> => {
      if (selected === null) return;
      setRowsLoading(true);
      try {
        const page = await getDatasetRows(selected.id, {
          limit: ROWS_PAGE_SIZE,
          offset,
        });
        setRows(page);
        setRowsOffset(offset);
      } catch (err) {
        setDetailError(errorMessage(err));
      } finally {
        setRowsLoading(false);
      }
    },
    [selected, errorMessage],
  );

  const onDelete = useCallback(
    async (id: string): Promise<void> => {
      setDeleting(id);
      try {
        await deleteDataset(id);
        if (selected?.id === id) {
          setSelected(null);
          setRows(null);
        }
        await reload();
      } catch (err) {
        setLoadError(errorMessage(err));
      } finally {
        setDeleting(null);
        setConfirmDelete(null);
      }
    },
    [selected, reload, errorMessage],
  );

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
              if (next !== null && name.trim().length === 0) {
                setName(next.name.replace(/\.csv$/i, ''));
              }
            }}
            className="text-sm text-[color:var(--fg-strong)] file:mr-3 file:rounded-md file:border file:border-[color:var(--border)] file:bg-[color:var(--card)] file:px-3 file:py-1.5 file:text-sm file:text-[color:var(--fg-strong)]"
          />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[color:var(--fg-muted)]">
              {t('upload.nameLabel')}
            </span>
            <input
              type="text"
              value={name}
              disabled={uploading}
              placeholder={t('upload.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-[color:var(--fg-strong)]"
            />
          </label>
          <div className="flex items-center justify-end">
            <Button
              variant="primary"
              onClick={() => void onUpload()}
              disabled={file === null || uploading}
            >
              {uploading ? t('upload.uploading') : t('upload.submit')}
            </Button>
          </div>
        </div>

        {uploadError !== null && (
          <div className="mt-3 rounded-md border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]">
            {uploadError}
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

        {items !== null && !loading && items.length === 0 && (
          <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-6 text-center text-sm text-[color:var(--fg-muted)]">
            {t('empty')}
          </div>
        )}

        {items !== null && items.length > 0 && (
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
                      <button
                        type="button"
                        onClick={() => void openDetail(ds.id)}
                        className="text-left font-medium text-[color:var(--fg-strong)] hover:text-[color:var(--accent)]"
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
                        <span className="inline-flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => void onDelete(ds.id)}
                            disabled={deleting === ds.id}
                            className="text-sm font-medium text-[color:var(--danger)] hover:underline disabled:opacity-50"
                          >
                            {deleting === ds.id
                              ? t('list.deleting')
                              : t('list.confirmDelete')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(null)}
                            disabled={deleting === ds.id}
                            className="text-sm text-[color:var(--fg-muted)] hover:underline disabled:opacity-50"
                          >
                            {t('list.cancel')}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(ds.id)}
                          className="text-sm text-[color:var(--danger)] hover:underline"
                        >
                          {t('list.delete')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Detail: schema + row preview */}
      {detailError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {detailError}
        </section>
      )}

      {selected !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('detail.heading', { name: selected.name })}
            </h2>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setRows(null);
              }}
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
          {rows !== null && rows.rows.length > 0 ? (
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
                    {rows.rows.map((row, i) => (
                      <tr key={i} className={ROW_CLS}>
                        {selected.columns.map((col) => (
                          <td
                            key={col.name}
                            className={`${TD_CLS} font-mono text-[color:var(--fg-muted)]`}
                          >
                            {String(row[col.name] ?? '')}
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
                    to: rowsOffset + rows.rows.length,
                    total: rows.totalMatched,
                  })}
                </span>
                <span className="inline-flex gap-2">
                  <button
                    type="button"
                    disabled={rowsOffset === 0 || rowsLoading}
                    onClick={() =>
                      void loadRowsPage(Math.max(0, rowsOffset - ROWS_PAGE_SIZE))
                    }
                    className="hover:text-[color:var(--fg-strong)] disabled:opacity-40"
                  >
                    {t('detail.prev')}
                  </button>
                  <button
                    type="button"
                    disabled={
                      rowsOffset + rows.rows.length >= rows.totalMatched ||
                      rowsLoading
                    }
                    onClick={() =>
                      void loadRowsPage(rowsOffset + ROWS_PAGE_SIZE)
                    }
                    className="hover:text-[color:var(--fg-strong)] disabled:opacity-40"
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
        </section>
      )}
    </main>
  );
}
