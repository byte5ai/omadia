'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import {
  listMergeCandidates,
  previewBulkMergeDetect,
  runBulkMergeDetect,
  type BulkMergeDetectPreviewDto,
  type BulkMergeDetectResultDto,
  type MergeCandidateDetailDto,
  type MergeCandidateStatus,
} from '../../_lib/api';

const STATUS_BADGE: Record<MergeCandidateStatus, string> = {
  open: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  resolved:
    'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  dismissed:
    'bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-300',
};

const BULK_CONFIRM_THRESHOLD = 100;
const BULK_DEFAULT_LIMIT = 50;
const BULK_HARD_CAP = 500;

export default function DuplicatesListPage(): React.ReactElement {
  const [statusFilter, setStatusFilter] = useState<MergeCandidateStatus | 'all'>(
    'open',
  );
  const [items, setItems] = useState<MergeCandidateDetailDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bulk-Detect-Panel state — mirrors Slice 9.5.
  const [bulkPreview, setBulkPreview] =
    useState<BulkMergeDetectPreviewDto | null>(null);
  const [bulkLimit, setBulkLimit] = useState<number>(BULK_DEFAULT_LIMIT);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResult, setBulkResult] =
    useState<BulkMergeDetectResultDto | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkPreviewError, setBulkPreviewError] = useState<string | null>(null);

  const loadBulkPreview = useCallback(async (): Promise<void> => {
    setBulkPreviewError(null);
    try {
      const preview = await previewBulkMergeDetect();
      setBulkPreview(preview);
    } catch (err) {
      setBulkPreviewError(err instanceof Error ? err.message : String(err));
      setBulkPreview(null);
    }
  }, []);

  const triggerBulkRun = useCallback(async (): Promise<void> => {
    if (bulkRunning) return;
    if (
      bulkLimit > BULK_CONFIRM_THRESHOLD &&
      !window.confirm(
        `Bulk-Merge-Detect für bis zu ${String(bulkLimit)} Memories starten? Cosine-only, kostenfrei — aber der Bulk-Scan ist O(n × top-k) cosine-Vergleiche.`,
      )
    ) {
      return;
    }
    setBulkRunning(true);
    setBulkError(null);
    setBulkResult(null);
    try {
      const result = await runBulkMergeDetect(bulkLimit);
      setBulkResult(result);
      void loadBulkPreview();
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkRunning(false);
    }
  }, [bulkLimit, bulkRunning, loadBulkPreview]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await listMergeCandidates(
        statusFilter === 'all' ? {} : { status: statusFilter },
      );
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  useEffect(() => {
    queueMicrotask(() => void loadBulkPreview());
  }, [loadBulkPreview]);

  useEffect(() => {
    if (bulkResult && bulkResult.mergeCandidatesCreated > 0) {
      queueMicrotask(() => void load());
    }
  }, [bulkResult, load]);

  const sorted = useMemo(() => {
    if (!items) return null;
    return [...items].sort(
      (a, b) => b.props.cosine_sim - a.props.cosine_sim,
    );
  }, [items]);

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Memory · Mögliche Duplikate
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          Memories die semantisch fast identisch sind (Cosine-Ähnlichkeit
          ≥ 0.95). Klick auf einen Eintrag öffnet die Side-by-side-Ansicht
          mit Merge-Knopf.
        </p>
      </header>

      <section
        aria-label="Bulk merge detect"
        className="mb-6 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
      >
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-semibold text-[color:var(--fg-strong)]">
            Bulk-Detect
          </h2>
          <p className="text-xs text-[color:var(--fg-muted)]">
            Memories die noch keinen Merge-Check hatten. Cosine-only, kein
            LLM, praktisch kostenfrei.
          </p>
        </div>

        {bulkPreviewError !== null && (
          <p className="mb-2 text-xs text-red-600 dark:text-red-300">
            Preview fehlgeschlagen: {bulkPreviewError}
          </p>
        )}

        {bulkPreview !== null && (
          <dl className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-neutral-500">ungeprüft</dt>
              <dd className="font-mono text-base">{bulkPreview.unchecked}</dd>
            </div>
            <div>
              <dt className="text-neutral-500">schon geprüft</dt>
              <dd className="font-mono text-base">
                {bulkPreview.alreadyChecked}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">ohne Embedding</dt>
              <dd className="font-mono text-base">
                {bulkPreview.withoutEmbedding}
              </dd>
            </div>
          </dl>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="bulk-limit" className="text-xs text-[color:var(--fg-muted)]">
            Limit
          </label>
          <input
            id="bulk-limit"
            type="number"
            min={1}
            max={BULK_HARD_CAP}
            value={bulkLimit}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(next)) {
                setBulkLimit(Math.max(1, Math.min(next, BULK_HARD_CAP)));
              }
            }}
            className="w-20 rounded border border-[color:var(--border)] bg-transparent px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={() => void triggerBulkRun()}
            disabled={
              bulkRunning || (bulkPreview !== null && bulkPreview.unchecked === 0)
            }
            className="rounded border border-neutral-900 bg-neutral-900 px-3 py-1 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-200 dark:bg-neutral-200 dark:text-neutral-900"
          >
            {bulkRunning ? 'läuft…' : 'Bulk-Detect starten'}
          </button>
          {bulkLimit > BULK_CONFIRM_THRESHOLD && (
            <span className="text-[11px] text-amber-700 dark:text-amber-300">
              ⚠️ Confirm bei Limit &gt; {BULK_CONFIRM_THRESHOLD}
            </span>
          )}
        </div>

        {bulkError !== null && (
          <p className="mt-3 text-xs text-red-600 dark:text-red-300">
            Run fehlgeschlagen: {bulkError}
          </p>
        )}

        {bulkResult !== null && (
          <div className="mt-3 rounded border border-[color:var(--border)] bg-black/5 p-3 text-xs dark:bg-white/5">
            <p className="mb-2 font-medium">
              Ergebnis · {bulkResult.durationMs} ms
            </p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <div>
                <dt className="text-neutral-500">scanned</dt>
                <dd className="font-mono">{bulkResult.scanned}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">checked</dt>
                <dd className="font-mono">{bulkResult.checked}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">neue Duplikate</dt>
                <dd className="font-mono">
                  {bulkResult.mergeCandidatesCreated}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">ohne Embedding</dt>
                <dd className="font-mono">{bulkResult.skippedNoEmbedding}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">Fehler</dt>
                <dd className="font-mono">{bulkResult.failed}</dd>
              </div>
            </dl>
          </div>
        )}
      </section>

      <div className="mb-4 flex flex-wrap gap-2">
        {(['open', 'resolved', 'dismissed', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={[
              'rounded border px-3 py-1 text-xs',
              statusFilter === s
                ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-200 dark:bg-neutral-200 dark:text-neutral-900'
                : 'border-neutral-300 hover:border-neutral-400 dark:border-neutral-700',
            ].join(' ')}
          >
            {s === 'all' ? 'alle' : s}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-700"
        >
          {loading ? 'lädt…' : 'aktualisieren'}
        </button>
      </div>

      {error !== null && (
        <div className="mb-4 border-l-2 border-red-400 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          Fehler: {error}
        </div>
      )}

      {sorted !== null && sorted.length === 0 && error === null && (
        <p className="text-sm italic text-neutral-500">
          Keine Duplikat-Kandidaten in dieser Auswahl.
        </p>
      )}

      {sorted !== null && sorted.length > 0 && (
        <ul className="flex flex-col gap-3">
          {sorted.map((mc) => (
            <li key={mc.id}>
              <Link
                href={`/admin/duplicates/${encodeURIComponent(mc.id)}`}
                className="block rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 transition-colors hover:border-[color:var(--accent)]"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
                  <span
                    className={[
                      'rounded px-1.5 py-0.5 uppercase tracking-wider',
                      STATUS_BADGE[mc.props.status],
                    ].join(' ')}
                  >
                    {mc.props.status}
                  </span>
                  <span className="rounded bg-violet-100 px-1.5 py-0.5 font-mono uppercase tracking-wider text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
                    cosine {mc.props.cosine_sim.toFixed(3)}
                  </span>
                  <time
                    className="font-mono text-neutral-500"
                    dateTime={mc.props.created_at}
                  >
                    {new Date(mc.props.created_at).toLocaleString('de-DE')}
                  </time>
                </div>
                <p className="text-sm text-neutral-900 dark:text-neutral-100">
                  {mc.mkA?.props.summary?.slice(0, 90) ?? '(MK A)'}
                </p>
                <p className="mt-1 text-xs text-neutral-700 dark:text-neutral-300">
                  ↔ {mc.mkB?.props.summary?.slice(0, 90) ?? '(MK B)'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
