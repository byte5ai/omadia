'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { Button } from '@/app/_components/ui/Button';
import {
  listInconsistencies,
  previewBulkInconsistencyDetect,
  runBulkInconsistencyDetect,
  type BulkInconsistencyPreviewDto,
  type BulkInconsistencyResultDto,
  type InconsistencyDetailDto,
  type InconsistencySeverity,
  type InconsistencyStatus,
} from '../../_lib/api';

const BULK_CONFIRM_THRESHOLD = 25;
const BULK_DEFAULT_LIMIT = 25;
const BULK_HARD_CAP = 200;

const SEVERITY_BADGE: Record<InconsistencySeverity, string> = {
  low: 'bg-[color:var(--state-loading)] text-[color:var(--fg)]',
  medium: 'bg-[color:var(--warning)] text-[color:var(--warning)]',
  high: 'bg-[color:var(--danger)]/15 text-[color:var(--danger)]',
};

const STATUS_BADGE: Record<InconsistencyStatus, string> = {
  open: 'bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
  resolved:
    'bg-[color:var(--success)]/10 text-[color:var(--success)]',
  dismissed:
    'bg-[color:var(--bg-soft)] text-[color:var(--fg)]',
};

const SEVERITY_RANK: Record<InconsistencySeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export default function InconsistenciesListPage(): React.ReactElement {
  const [statusFilter, setStatusFilter] = useState<InconsistencyStatus | 'all'>(
    'open',
  );
  const [items, setItems] = useState<InconsistencyDetailDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Slice 9.5 — Bulk-Detect-Panel state ──────────────────────────────
  const [bulkPreview, setBulkPreview] =
    useState<BulkInconsistencyPreviewDto | null>(null);
  const [bulkLimit, setBulkLimit] = useState<number>(BULK_DEFAULT_LIMIT);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResult, setBulkResult] =
    useState<BulkInconsistencyResultDto | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkPreviewError, setBulkPreviewError] = useState<string | null>(null);

  const loadBulkPreview = useCallback(async (): Promise<void> => {
    setBulkPreviewError(null);
    try {
      const preview = await previewBulkInconsistencyDetect();
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
        `Bulk-Detect für bis zu ${String(bulkLimit)} Memories starten? Pro Memory bis zu 5 Haiku-Calls — Kosten skalieren mit dem Limit.`,
      )
    ) {
      return;
    }
    setBulkRunning(true);
    setBulkError(null);
    setBulkResult(null);
    try {
      const result = await runBulkInconsistencyDetect(bulkLimit);
      setBulkResult(result);
      // Refresh preview-counts + inconsistency-list so newly flagged
      // conflicts surface immediately.
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
      const res = await listInconsistencies(
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

  // After a bulk run, surface freshly-flagged inconsistencies in the
  // list below.
  useEffect(() => {
    if (bulkResult && bulkResult.inconsistenciesCreated > 0) {
      queueMicrotask(() => void load());
    }
  }, [bulkResult, load]);

  const sorted = useMemo(() => {
    if (!items) return null;
    return [...items].sort(
      (a, b) =>
        SEVERITY_RANK[b.props.severity] - SEVERITY_RANK[a.props.severity],
    );
  }, [items]);

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
          Memory · Widersprüche
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          Memories die semantisch verwandt sind aber inhaltlich widersprechen.
          Klick auf einen Eintrag öffnet die Side-by-side-Ansicht zum Auflösen.
        </p>
      </header>

      {/* Slice 9.5 — Bulk-Detect-Panel. Sits above the filter row so
          the operator sees the marker-progress at a glance. */}
      <section
        aria-label="Bulk inconsistency detect"
        className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
      >
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-semibold text-[color:var(--fg-strong)]">
            Bulk-Detect
          </h2>
          <p className="text-xs text-[color:var(--fg-muted)]">
            Memories die noch keinen Inconsistency-Check hatten (= aus Zeiten
            vor Slice 9).
          </p>
        </div>

        {bulkPreviewError !== null && (
          <p className="mb-2 text-xs text-[color:var(--danger)]">
            Preview fehlgeschlagen: {bulkPreviewError}
          </p>
        )}

        {bulkPreview !== null && (
          <dl className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-[color:var(--fg-muted)]">ungeprüft</dt>
              <dd className="font-mono text-base">{bulkPreview.unchecked}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--fg-muted)]">schon geprüft</dt>
              <dd className="font-mono text-base">
                {bulkPreview.alreadyChecked}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--fg-muted)]">ohne Embedding</dt>
              <dd className="font-mono text-base">
                {bulkPreview.withoutEmbedding}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--fg-muted)]">Detector</dt>
              <dd
                className={[
                  'font-mono text-base',
                  bulkPreview.detectorAvailable
                    ? 'text-[color:var(--success)]'
                    : 'text-[color:var(--warning)]',
                ].join(' ')}
              >
                {bulkPreview.detectorAvailable ? 'ready' : 'kein Key'}
              </dd>
            </div>
          </dl>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label
            htmlFor="bulk-limit"
            className="text-xs text-[color:var(--fg-muted)]"
          >
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
          <Button
            variant="primary"
            size="sm"
            onClick={() => void triggerBulkRun()}
            disabled={
              bulkRunning ||
              bulkPreview?.detectorAvailable === false ||
              (bulkPreview !== null && bulkPreview.unchecked === 0)
            }
            busy={bulkRunning}
            busyLabel="läuft"
          >
            Bulk-Detect starten
          </Button>
          {bulkLimit > BULK_CONFIRM_THRESHOLD && (
            <span className="text-[11px] text-[color:var(--warning)]">
              ⚠️ Cost-Confirm bei Limit &gt; {BULK_CONFIRM_THRESHOLD}
            </span>
          )}
        </div>

        {bulkError !== null && (
          <p className="mt-3 text-xs text-[color:var(--danger)]">
            Run fehlgeschlagen: {bulkError}
          </p>
        )}

        {bulkResult !== null && (
          <div className="mt-3 rounded border border-[color:var(--border)] bg-black/5 p-3 text-xs">
            <p className="mb-2 font-medium">
              Ergebnis · {bulkResult.durationMs} ms
            </p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <div>
                <dt className="text-[color:var(--fg-muted)]">scanned</dt>
                <dd className="font-mono">{bulkResult.scanned}</dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">checked</dt>
                <dd className="font-mono">{bulkResult.checked}</dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">neue Konflikte</dt>
                <dd className="font-mono">
                  {bulkResult.inconsistenciesCreated}
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">ohne Embedding</dt>
                <dd className="font-mono">{bulkResult.skippedNoEmbedding}</dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">Fehler</dt>
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
                ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
                : 'border-[color:var(--border)] hover:border-[color:var(--border-strong)]',
            ].join(' ')}
          >
            {s === 'all' ? 'alle' : s}
          </button>
        ))}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto"
        >
          {loading ? 'lädt…' : 'aktualisieren'}
        </Button>
      </div>

      {error !== null && (
        <div className="mb-4 border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
          Fehler: {error}
        </div>
      )}

      {sorted !== null && sorted.length === 0 && error === null && (
        <p className="text-sm italic text-[color:var(--fg-muted)]">
          Keine Widersprüche in dieser Auswahl.
        </p>
      )}

      {sorted !== null && sorted.length > 0 && (
        <ul className="flex flex-col gap-3">
          {sorted.map((inc) => (
            <li key={inc.id}>
              <Link
                href={`/admin/inconsistencies/${encodeURIComponent(inc.id)}`}
                className="block rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 transition-colors hover:border-[color:var(--accent)]"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
                  <span
                    className={[
                      'rounded px-2 py-0.5 uppercase tracking-wider',
                      SEVERITY_BADGE[inc.props.severity],
                    ].join(' ')}
                  >
                    {inc.props.severity}
                  </span>
                  <span
                    className={[
                      'rounded px-2 py-0.5 uppercase tracking-wider',
                      STATUS_BADGE[inc.props.status],
                    ].join(' ')}
                  >
                    {inc.props.status}
                  </span>
                  <time
                    className="font-mono text-[color:var(--fg-muted)]"
                    dateTime={inc.props.created_at}
                  >
                    {new Date(inc.props.created_at).toLocaleString('de-DE')}
                  </time>
                </div>
                <p className="text-sm text-[color:var(--fg-strong)]">
                  {inc.props.summary}
                </p>
                <p className="mt-2 font-mono text-[10px] text-[color:var(--fg-muted)]">
                  {inc.mkA?.props.summary?.slice(0, 60) ?? '(MK A)'} ↔{' '}
                  {inc.mkB?.props.summary?.slice(0, 60) ?? '(MK B)'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
