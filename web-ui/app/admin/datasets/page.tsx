'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  deleteDataset,
  getDataset,
  getDatasetRows,
  listDatasets,
  type DatasetSummary,
} from '../../_lib/api';
import { DatasetDetail } from './_components/DatasetDetail';
import { UploadSection } from './_components/UploadSection';
import {
  LIST_PER_PAGE,
  ROWS_PER_PAGE,
  toFriendlyError,
  type DetailState,
} from './_components/shared';

/**
 * Admin → Knowledge · Datasets (#532, the admin half of #430).
 *
 * Upload a CSV, read back its inferred schema and a row preview, delete it
 * again. Backed by `/bot-api/v1/datasets` — `requireAuth` plus a per-route
 * session-user ACL, so this page only ever shows datasets the logged-in
 * operator imported themselves. There is no team or public visibility tier
 * yet; "no datasets" here does not mean the instance has none.
 *
 * Both the dataset list and the row preview are server-paginated
 * (`limit`/`offset`, clamped to 200 server-side). For rows that guards
 * against 50 000-row datasets; for the list it guards against the review
 * finding on #598: datasets past the server's page cap used to be invisible
 * AND undeletable from this page.
 *
 * Upload receipt: every imported row runs through the SAME privacy scan as the
 * chat-attachment auto-ingest path, so the scanned/masked cell counts are
 * shown on success — an operator uploading customer data should be able to see
 * that the masking actually ran, not take it on trust.
 */

type ListState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      datasets: DatasetSummary[];
      /** Count before limit/offset; `null` when the backend can't count. */
      totalMatched: number | null;
    }
  | { kind: 'error'; message: string };

export default function AdminDatasetsPage(): React.ReactElement {
  const t = useTranslations('adminDatasets');
  const format = useFormatter();

  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [listOffset, setListOffset] = useState(0);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // per-row pending delete + the single expanded detail panel
  const [pending, setPending] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);

  /**
   * Monotonic request ids. An awaited response only writes state when it is
   * still the LATEST request of its kind — otherwise a slow page 1 arriving
   * after a fast page 2 (or dataset A's rows arriving after B was opened)
   * would overwrite the newer view with stale data (#598 review must-fix 2).
   */
  const listReq = useRef(0);
  const detailReq = useRef(0);
  /** Which dataset the latest detail request targets — so deleting dataset A
   *  invalidates A's in-flight load without stranding a concurrent load of B. */
  const detailTarget = useRef<string | null>(null);

  const reload = useCallback(
    async function reloadPage(offset: number): Promise<void> {
      const req = ++listReq.current;
      try {
        const page = await listDatasets({ limit: LIST_PER_PAGE, offset });
        if (listReq.current !== req) return;
        if (page.items.length === 0 && offset > 0) {
          // Deleting the only dataset of the last page leaves an empty page —
          // step back instead of showing "no datasets" while some exist.
          await reloadPage(Math.max(0, offset - LIST_PER_PAGE));
          return;
        }
        setListOffset(offset);
        setState({
          kind: 'ready',
          datasets: page.items,
          totalMatched: page.totalMatched ?? null,
        });
      } catch (err) {
        if (listReq.current !== req) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [],
  );

  useEffect(() => {
    // Fetch-on-mount: `state` already starts at `loading`, so the awaited
    // fetch is the only thing that moves it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload(0);
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
      const req = ++detailReq.current;
      detailTarget.current = id;
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
        if (detailReq.current !== req) return;
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
        if (detailReq.current !== req) return;
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
        // Invalidate any in-flight load so it cannot re-open the panel.
        detailReq.current++;
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

  const onDelete = useCallback(
    async (d: DatasetSummary): Promise<void> => {
      if (!confirm(t('confirmDelete', { name: d.name }))) return;
      setDeleteError(null);
      setPending(d.id);
      try {
        await deleteDataset(d.id);
        if (detailTarget.current === d.id) detailReq.current++;
        setDetail((prev) => (prev?.id === d.id ? null : prev));
        await reload(listOffset);
      } catch (err) {
        setDeleteError(toFriendlyError(err, t));
        // Resync anyway: the server may have deleted the row despite the
        // error surfacing here, and a stale row invites a second delete.
        await reload(listOffset);
      } finally {
        setPending(null);
      }
    },
    [listOffset, reload, t],
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

      <UploadSection onUploaded={() => reload(0)} />

      {deleteError !== null && (
        <p className="mb-6 text-sm text-[color:var(--danger)]">{deleteError}</p>
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
          {state.totalMatched === null && state.datasets.length >= LIST_PER_PAGE && (
            // Backend without `countDatasets`: we cannot page reliably, so at
            // least say the list may be cut instead of ending it silently.
            <p className="mb-3 text-[13px] text-[color:var(--fg-muted)]">
              {t('listCapped', { cap: format.number(LIST_PER_PAGE) })}
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

          {state.totalMatched !== null && state.totalMatched > LIST_PER_PAGE && (
            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="text-[13px] text-[color:var(--fg-muted)]">
                {t('listRange', {
                  from: format.number(listOffset + 1),
                  to: format.number(listOffset + state.datasets.length),
                  total: format.number(state.totalMatched),
                })}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    void reload(Math.max(0, listOffset - LIST_PER_PAGE))
                  }
                  disabled={listOffset === 0}
                >
                  {t('previousPage')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void reload(listOffset + LIST_PER_PAGE)}
                  disabled={
                    listOffset + state.datasets.length >= state.totalMatched
                  }
                >
                  {t('nextPage')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
