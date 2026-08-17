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
  type DatasetSummary,
  type DatasetUploadResponse,
} from '../../_lib/api';

/**
 * Admin → Knowledge · Datasets (#532, the admin half of #430).
 *
 * Upload a CSV, read back its inferred schema and a row preview, delete it
 * again. Backed by `/bot-api/v1/datasets` — `requireAuth` plus a per-route
 * session-user ACL, so this page only ever shows datasets the logged-in
 * operator imported themselves. There is no team or public visibility tier
 * yet; "no datasets" here does not mean the instance has none.
 *
 * The row preview is deliberately server-paginated (`limit`/`offset`, clamped
 * to 200 server-side) rather than fetched whole: a dataset can hold up to
 * `MAX_DATASET_ROWS` (50 000) rows and pulling that into the DOM to show the
 * first screenful would be the same mistake `queryDatasetRows` exists to
 * prevent.
 *
 * Upload receipt: every imported row runs through the SAME privacy scan as the
 * chat-attachment auto-ingest path, so the scanned/masked cell counts are
 * shown on success — an operator uploading customer data should be able to see
 * that the masking actually ran, not take it on trust.
 */

/** Row-preview page size. Server clamps `limit` to [1, 200]. */
const ROWS_PER_PAGE = 25;
/** Mirrors `MAX_DATASET_ROWS` in `@omadia/orchestrator`'s `datasetImport.ts` —
 *  stated up front so an operator learns the cap before a 50 001-row CSV is
 *  rejected, not after. Display only; the server owns enforcement. */
const MAX_DATASET_ROWS = 50_000;
/** Mirrors `MAX_UPLOAD_BYTES` in the datasets route (25 MiB), same reason. */
const MAX_UPLOAD_MB = 25;
/**
 * `GET /v1/datasets` passes no `limit`, so `listDatasets` applies its own
 * default of 50 and the route exposes no way to raise it. Hitting exactly this
 * many is therefore indistinguishable from "there are more" — say so rather
 * than let the list quietly end.
 */
const LIST_CAP = 50;

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; datasets: DatasetSummary[] }
  | { kind: 'error'; message: string };

/** The expanded dataset's schema + current row page. */
type DetailState = {
  id: string;
  dataset: DatasetSummary | null;
  rows: Array<Record<string, unknown>>;
  totalMatched: number;
  offset: number;
  loading: boolean;
  error: string | null;
};

type TFn = (key: string, values?: Record<string, string | number>) => string;

export default function AdminDatasetsPage(): React.ReactElement {
  const t = useTranslations('adminDatasets');
  const format = useFormatter();

  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);

  // upload form
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [receipt, setReceipt] = useState<DatasetUploadResponse | null>(null);
  /**
   * A file input is uncontrolled: clearing `file` state does NOT clear the
   * element, and re-picking the SAME file then fires no `change` event
   * (the element's value is unchanged), so state would stay `null` while the
   * element still shows a filename — the Import button dead with no
   * explanation. Reset the element itself after a successful import.
   */
  const fileInputRef = useRef<HTMLInputElement>(null);

  // per-row pending delete + the single expanded detail panel
  const [pending, setPending] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setState({ kind: 'ready', datasets: await listDatasets() });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: `state` already starts at `loading`, so the awaited
    // fetch is the only thing that moves it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  /**
   * Open (or re-page) the detail panel. `known` is the schema already held for
   * this dataset, so turning a page costs ONE request — the schema is fetched
   * on the first open and never again while the panel stays open.
   */
  const loadDetail = useCallback(
    async (
      id: string,
      offset: number,
      known: DatasetSummary | null,
    ): Promise<void> => {
      setDetail((prev) =>
        prev?.id === id
          ? { ...prev, loading: true, error: null }
          : {
              id,
              dataset: known,
              rows: [],
              totalMatched: 0,
              offset,
              loading: true,
              error: null,
            },
      );
      try {
        const [dataset, page] = await Promise.all([
          known ?? getDataset(id),
          getDatasetRows(id, { limit: ROWS_PER_PAGE, offset }),
        ]);
        setDetail({
          id,
          dataset,
          rows: page.rows ?? [],
          totalMatched: page.totalMatched,
          offset,
          loading: false,
          error: null,
        });
      } catch (err) {
        setDetail({
          id,
          dataset: null,
          rows: [],
          totalMatched: 0,
          offset,
          loading: false,
          error: toFriendlyError(err, t),
        });
      }
    },
    [t],
  );

  const onToggleDetail = useCallback(
    (id: string): void => {
      if (detail?.id === id) {
        setDetail(null);
        return;
      }
      // `null`, not the summary already in the list: on open the schema is
      // re-read alongside the rows, so the preview table's headers and its
      // rows are guaranteed to describe the same moment. The listing can be
      // minutes old (another tab, another import).
      void loadDetail(id, 0, null);
    },
    [detail, loadDetail],
  );

  const onUpload = useCallback(async (): Promise<void> => {
    if (!file) return;
    setActionError(null);
    setReceipt(null);
    setUploading(true);
    try {
      const result = await uploadDataset(file, name);
      setReceipt(result);
      setFile(null);
      setName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await reload();
    } catch (err) {
      setActionError(toFriendlyError(err, t));
    } finally {
      setUploading(false);
    }
  }, [file, name, reload, t]);

  const onDelete = useCallback(
    async (d: DatasetSummary): Promise<void> => {
      if (!confirm(t('confirmDelete', { name: d.name }))) return;
      setActionError(null);
      setPending(d.id);
      try {
        await deleteDataset(d.id);
        setDetail((prev) => (prev?.id === d.id ? null : prev));
        await reload();
      } catch (err) {
        setActionError(toFriendlyError(err, t));
      } finally {
        setPending(null);
      }
    },
    [reload, t],
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
        <h1 className="mt-2 font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t.rich('intro', {
            code: (chunks) => (
              <code className="rounded bg-[color:var(--card)] px-1 py-0.5 text-[12px]">
                {chunks}
              </code>
            ),
          })}
        </p>
      </header>

      {/* Upload */}
      <section className="mb-8 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <h2 className="mb-4 text-[15px] font-semibold text-[color:var(--fg-strong)]">
          {t('uploadHeading')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-[2fr_2fr_auto] sm:items-end">
          <Field label={t('fields.file')}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              aria-label={t('fields.file')}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setReceipt(null);
                setActionError(null);
              }}
              className={inputCls}
            />
          </Field>
          <Field label={t('fields.nameOptional')}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={file?.name ?? t('placeholders.name')}
              className={inputCls}
            />
          </Field>
          <Button
            variant="primary"
            onClick={() => void onUpload()}
            disabled={file === null || uploading}
            busy={uploading}
            busyLabel={t('uploading')}
          >
            {t('upload')}
          </Button>
        </div>
        <p className="mt-3 text-[13px] text-[color:var(--fg-muted)]">
          {t('uploadLimits', {
            maxRows: format.number(MAX_DATASET_ROWS),
            maxMb: format.number(MAX_UPLOAD_MB),
          })}
        </p>
      </section>

      {receipt !== null && (
        <section className="mb-8 rounded-lg border border-[color:var(--success)]/50 bg-[color:var(--success)]/8 p-4 text-sm">
          <p className="font-semibold text-[color:var(--success)]">
            {t('receipt.imported', {
              rows: format.number(receipt.dataset.rowCount),
            })}
          </p>
          <p className="mt-1 text-[color:var(--fg-muted)]">
            {t('receipt.privacyScan', {
              scanned: format.number(receipt.privacyScan.scannedCells),
              masked: format.number(receipt.privacyScan.maskedCells),
            })}
          </p>
          {receipt.truncation.truncatedCellCount > 0 && (
            <p className="mt-1 text-[color:var(--warning)]">
              {t('receipt.truncated', {
                cells: format.number(receipt.truncation.truncatedCellCount),
                columns: receipt.truncation.truncatedColumns.join(', '),
              })}
            </p>
          )}
        </section>
      )}

      {actionError !== null && (
        <p className="mb-6 text-sm text-[color:var(--danger)]">{actionError}</p>
      )}

      {/* Listing */}
      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-[color:var(--danger)]">
          {t('loadError', { message: state.message })}
        </p>
      ) : state.datasets.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
      ) : (
        <>
          {state.datasets.length >= LIST_CAP && (
            <p className="mb-3 text-[13px] text-[color:var(--fg-muted)]">
              {t('listCapped', { cap: format.number(LIST_CAP) })}
            </p>
          )}
          <ul className="flex flex-col gap-3">
            {state.datasets.map((d) => (
              <li
                key={d.id}
                className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex flex-1 flex-col gap-1">
                    <span className="text-[15px] font-semibold text-[color:var(--fg-strong)]">
                      {d.name}
                    </span>
                    <span className="text-[13px] text-[color:var(--fg-muted)]">
                      {t('meta', {
                        rows: format.number(d.rowCount),
                        columns: format.number(d.columns.length),
                        created: format.dateTime(new Date(d.createdAt), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }),
                      })}
                    </span>
                    <code className="text-[12px] text-[color:var(--fg-muted)]">
                      {d.sourceFileName}
                    </code>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => onToggleDetail(d.id)}
                      aria-expanded={detail?.id === d.id}
                    >
                      {detail?.id === d.id ? t('hideDetails') : t('showDetails')}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => void onDelete(d)}
                      busy={pending === d.id}
                      busyLabel={t('remove')}
                    >
                      {t('remove')}
                    </Button>
                  </div>
                </div>

                {detail?.id === d.id && (
                  <DatasetDetail
                    detail={detail}
                    onPage={(offset) =>
                      void loadDetail(d.id, offset, detail.dataset)
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

/** Schema table + paginated row preview for the one expanded dataset. */
function DatasetDetail({
  detail,
  onPage,
}: {
  detail: DetailState;
  onPage: (offset: number) => void;
}): React.ReactElement {
  const t = useTranslations('adminDatasets');
  const format = useFormatter();

  if (detail.error !== null) {
    return (
      <p className="mt-4 border-t border-[color:var(--border)] pt-4 text-sm text-[color:var(--danger)]">
        {detail.error}
      </p>
    );
  }
  if (detail.dataset === null) {
    return (
      <p className="mt-4 border-t border-[color:var(--border)] pt-4 text-sm opacity-70">
        {t('loading')}
      </p>
    );
  }

  const columns = detail.dataset.columns;
  const from = detail.totalMatched === 0 ? 0 : detail.offset + 1;
  const to = Math.min(detail.offset + detail.rows.length, detail.totalMatched);

  return (
    <div className="mt-4 border-t border-[color:var(--border)] pt-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        {t('schemaHeading')}
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-[color:var(--fg-muted)]">
              <th className={thCls}>{t('schema.column')}</th>
              <th className={thCls}>{t('schema.type')}</th>
              <th className={thCls}>{t('schema.sample')}</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.name} className="border-t border-[color:var(--border)]">
                <td className={tdCls}>{c.name}</td>
                <td className={`${tdCls} font-mono`}>{c.type}</td>
                <td className={`${tdCls} text-[color:var(--fg-muted)]`}>
                  {c.sample ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        {t('rowsHeading')}
      </h3>
      {detail.loading ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : detail.rows.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('noRows')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="text-[color:var(--fg-muted)]">
                  {columns.map((c) => (
                    <th key={c.name} className={thCls}>
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((row, i) => (
                  <tr
                    key={detail.offset + i}
                    className="border-t border-[color:var(--border)]"
                  >
                    {columns.map((c) => (
                      <td key={c.name} className={tdCls}>
                        {renderCell(row[c.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between gap-4">
            <span className="text-[13px] text-[color:var(--fg-muted)]">
              {t('rowsRange', {
                from: format.number(from),
                to: format.number(to),
                total: format.number(detail.totalMatched),
              })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onPage(Math.max(0, detail.offset - ROWS_PER_PAGE))}
                disabled={detail.offset === 0}
              >
                {t('previousPage')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onPage(detail.offset + ROWS_PER_PAGE)}
                disabled={to >= detail.totalMatched}
              >
                {t('nextPage')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]';
const thCls = 'px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]';
const tdCls = 'px-2 py-1 align-top';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * Cells arrive as `unknown` — the row store keeps the CSV's own values, which
 * are strings today but typed loosely enough that a future non-string backend
 * value would otherwise render as `[object Object]` or crash React.
 */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The `dataset.*` codes the route emits, mapped to localized copy. Kept local
 * rather than added to `errorHelp.ts`: that catalogue's coverage test scopes it
 * to five specific route files and fails on codes from anywhere else as
 * orphans. Same local-mapping shape as `/admin/registries`.
 */
function toFriendlyError(err: unknown, t: TFn): string {
  if (err instanceof ApiError) {
    if (err.status === 413 || err.code === 'dataset.limit_file_size') {
      return t('errors.tooLarge');
    }
    if (err.code === 'dataset.unsupported_type') return t('errors.notCsv');
    if (err.code === 'dataset.no_file') return t('errors.noFile');
    if (err.code === 'dataset.import_failed') {
      // The route's `reason` is the parser's own diagnostic (ragged rows, row
      // cap, empty file) and has no stable code behind it — surface it as
      // detail under a localized headline rather than as the headline.
      return t('errors.importFailed', { detail: apiMessage(err) });
    }
    if (err.code === 'dataset.not_found') return t('errors.notFound');
    return t('errors.generic', { status: err.status });
  }
  return err instanceof Error ? err.message : String(err);
}

/** The server's untranslated `message`, for use as secondary detail only. */
function apiMessage(err: ApiError): string {
  try {
    const parsed = JSON.parse(err.body) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : '';
  } catch {
    return '';
  }
}
