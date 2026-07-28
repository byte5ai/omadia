'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  listExcerptMergeCandidates,
  listMergeCandidates,
  previewBulkExcerptMergeDetect,
  previewBulkMergeDetect,
  runBulkExcerptMergeDetect,
  runBulkMergeDetect,
  type BulkExcerptMergeDetectPreviewDto,
  type BulkExcerptMergeDetectResultDto,
  type BulkMergeDetectPreviewDto,
  type BulkMergeDetectResultDto,
  type ExcerptMergeDetailDto,
  type ExcerptMergeStatus,
  type MergeCandidateDetailDto,
  type MergeCandidateStatus,
} from '../../_lib/api';

type TabKey = 'memories' | 'excerpts';

const STATUS_BADGE: Record<MergeCandidateStatus, string> = {
  open: 'bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
  resolved:
    'bg-[color:var(--success)]/10 text-[color:var(--success)]',
  dismissed:
    'bg-[color:var(--bg-soft)] text-[color:var(--fg)]',
};

const BULK_CONFIRM_THRESHOLD = 100;
const BULK_DEFAULT_LIMIT = 50;
const BULK_HARD_CAP = 500;

export default function DuplicatesListPage(): React.ReactElement {
  const t = useTranslations('adminDuplicates.list');
  const [tab, setTab] = useState<TabKey>('memories');
  const [statusFilter, setStatusFilter] = useState<MergeCandidateStatus | 'all'>(
    'open',
  );
  const [items, setItems] = useState<MergeCandidateDetailDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Slice 12 — Excerpt tab state ──────────────────────────────────
  const [excerptItems, setExcerptItems] = useState<
    ExcerptMergeDetailDto[] | null
  >(null);
  const [excerptLoading, setExcerptLoading] = useState(false);
  const [excerptError, setExcerptError] = useState<string | null>(null);
  const [excerptStatusFilter, setExcerptStatusFilter] = useState<
    ExcerptMergeStatus | 'all'
  >('open');

  const [excerptBulkPreview, setExcerptBulkPreview] =
    useState<BulkExcerptMergeDetectPreviewDto | null>(null);
  const [excerptBulkLimit, setExcerptBulkLimit] = useState<number>(BULK_DEFAULT_LIMIT);
  const [excerptBulkRunning, setExcerptBulkRunning] = useState(false);
  const [excerptBulkResult, setExcerptBulkResult] =
    useState<BulkExcerptMergeDetectResultDto | null>(null);
  const [excerptBulkError, setExcerptBulkError] = useState<string | null>(null);
  const [excerptBulkPreviewError, setExcerptBulkPreviewError] =
    useState<string | null>(null);

  const loadExcerptBulkPreview = useCallback(async (): Promise<void> => {
    setExcerptBulkPreviewError(null);
    try {
      setExcerptBulkPreview(await previewBulkExcerptMergeDetect());
    } catch (err) {
      setExcerptBulkPreviewError(
        err instanceof Error ? err.message : String(err),
      );
      setExcerptBulkPreview(null);
    }
  }, []);

  const triggerExcerptBulkRun = useCallback(async (): Promise<void> => {
    if (excerptBulkRunning) return;
    if (
      excerptBulkLimit > BULK_CONFIRM_THRESHOLD &&
      !window.confirm(t('confirmExcerptBulkRun', { count: excerptBulkLimit }))
    ) {
      return;
    }
    setExcerptBulkRunning(true);
    setExcerptBulkError(null);
    setExcerptBulkResult(null);
    try {
      const result = await runBulkExcerptMergeDetect(excerptBulkLimit);
      setExcerptBulkResult(result);
      void loadExcerptBulkPreview();
    } catch (err) {
      setExcerptBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setExcerptBulkRunning(false);
    }
  }, [excerptBulkLimit, excerptBulkRunning, loadExcerptBulkPreview, t]);

  const loadExcerpts = useCallback(async (): Promise<void> => {
    setExcerptLoading(true);
    setExcerptError(null);
    try {
      const res = await listExcerptMergeCandidates(
        excerptStatusFilter === 'all' ? {} : { status: excerptStatusFilter },
      );
      setExcerptItems(res.items);
    } catch (err) {
      setExcerptError(err instanceof Error ? err.message : String(err));
      setExcerptItems([]);
    } finally {
      setExcerptLoading(false);
    }
  }, [excerptStatusFilter]);

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
      !window.confirm(t('confirmBulkRun', { count: bulkLimit }))
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
  }, [bulkLimit, bulkRunning, loadBulkPreview, t]);

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
    if (tab === 'memories') queueMicrotask(() => void load());
    else queueMicrotask(() => void loadExcerpts());
  }, [tab, load, loadExcerpts]);

  useEffect(() => {
    if (tab === 'memories') queueMicrotask(() => void loadBulkPreview());
    else queueMicrotask(() => void loadExcerptBulkPreview());
  }, [tab, loadBulkPreview, loadExcerptBulkPreview]);

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
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-6">
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

      {/* Slice 12 — Tab switcher MK | Excerpt */}
      <div className="mb-6 flex flex-wrap gap-2 border-b border-[color:var(--border)]">
        {(['memories', 'excerpts'] as const).map((tabKey) => (
          <button
            key={tabKey}
            type="button"
            onClick={() => setTab(tabKey)}
            className={[
              '-mb-px rounded-t border-b-2 px-3 py-2 text-sm font-medium transition',
              tab === tabKey
                ? 'border-[color:var(--accent)] text-[color:var(--fg-strong)]'
                : 'border-transparent text-[color:var(--fg-muted)] hover:text-[color:var(--fg)]',
            ].join(' ')}
          >
            {tabKey === 'memories' ? t('tabs.memories') : t('tabs.excerpts')}
          </button>
        ))}
      </div>

      {tab === 'memories' && (
      <>
      <section
        aria-label={t('bulkDetectAria')}
        className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
      >
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-semibold text-[color:var(--fg-strong)]">
            {t('bulkDetectTitle')}
          </h2>
          <p className="text-xs text-[color:var(--fg-muted)]">
            {t('bulkDetectDescription')}
          </p>
        </div>

        {bulkPreviewError !== null && (
          <p className="mb-2 text-xs text-[color:var(--danger)]">
            {t('previewFailed', { message: bulkPreviewError })}
          </p>
        )}

        {bulkPreview !== null && (
          <dl className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-[color:var(--fg-muted)]">{t('unchecked')}</dt>
              <dd className="font-mono text-base">{bulkPreview.unchecked}</dd>
            </div>
            <div>
              <dt className="text-[color:var(--fg-muted)]">
                {t('alreadyChecked')}
              </dt>
              <dd className="font-mono text-base">
                {bulkPreview.alreadyChecked}
              </dd>
            </div>
            <div>
              <dt className="text-[color:var(--fg-muted)]">
                {t('withoutEmbedding')}
              </dt>
              <dd className="font-mono text-base">
                {bulkPreview.withoutEmbedding}
              </dd>
            </div>
          </dl>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="bulk-limit" className="text-xs text-[color:var(--fg-muted)]">
            {t('limitLabel')}
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
              bulkRunning || (bulkPreview !== null && bulkPreview.unchecked === 0)
            }
            busy={bulkRunning}
            busyLabel={t('running')}
          >
            {t('startBulkDetect')}
          </Button>
          {bulkLimit > BULK_CONFIRM_THRESHOLD && (
            <span className="text-[11px] text-[color:var(--warning)]">
              {t('confirmHint', { limit: BULK_CONFIRM_THRESHOLD })}
            </span>
          )}
        </div>

        {bulkError !== null && (
          <p className="mt-3 text-xs text-[color:var(--danger)]">
            {t('runFailed', { message: bulkError })}
          </p>
        )}

        {bulkResult !== null && (
          <div className="mt-3 rounded border border-[color:var(--border)] bg-black/5 p-3 text-xs">
            <p className="mb-2 font-medium">
              {t('resultTitle', { duration: bulkResult.durationMs })}
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
                <dt className="text-[color:var(--fg-muted)]">
                  {t('newDuplicates')}
                </dt>
                <dd className="font-mono">
                  {bulkResult.mergeCandidatesCreated}
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">
                  {t('withoutEmbedding')}
                </dt>
                <dd className="font-mono">{bulkResult.skippedNoEmbedding}</dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">{t('errors')}</dt>
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
            {s === 'all' ? t('statusAll') : s}
          </button>
        ))}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto"
        >
          {loading ? t('loading') : t('refresh')}
        </Button>
      </div>

      {error !== null && (
        <div className="mb-4 border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
          {t('error', { message: error })}
        </div>
      )}

      {sorted !== null && sorted.length === 0 && error === null && (
        <p className="text-sm italic text-[color:var(--fg-muted)]">
          {t('emptyMemories')}
        </p>
      )}

      {sorted !== null && sorted.length > 0 && (
        <ul className="flex flex-col gap-3">
          {sorted.map((mc) => (
            <li key={mc.id}>
              <Link
                href={`/admin/duplicates/${encodeURIComponent(mc.id)}`}
                className="block rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 transition-colors hover:border-[color:var(--accent)]"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
                  <span
                    className={[
                      'rounded px-2 py-0.5 uppercase tracking-wider',
                      STATUS_BADGE[mc.props.status],
                    ].join(' ')}
                  >
                    {mc.props.status}
                  </span>
                  <span className="rounded bg-[color:var(--accent)]/10 px-2 py-0.5 font-mono uppercase tracking-wider text-[color:var(--accent)]">
                    cosine {mc.props.cosine_sim.toFixed(3)}
                  </span>
                  <time
                    className="font-mono text-[color:var(--fg-muted)]"
                    dateTime={mc.props.created_at}
                  >
                    {new Date(mc.props.created_at).toLocaleString('de-DE')}
                  </time>
                </div>
                <p className="text-sm text-[color:var(--fg-strong)]">
                  {mc.mkA?.props.summary?.slice(0, 90) ?? '(MK A)'}
                </p>
                <p className="mt-1 text-xs text-[color:var(--fg)]">
                  ↔ {mc.mkB?.props.summary?.slice(0, 90) ?? '(MK B)'}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      </>
      )}

      {tab === 'excerpts' && (
      <>
        {/* Slice 12 — Excerpt Bulk Detect panel */}
        <section
          aria-label={t('bulkDetectExcerptsAria')}
          className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
        >
          <div className="mb-3 flex flex-wrap items-baseline gap-3">
            <h2 className="text-sm font-semibold text-[color:var(--fg-strong)]">
              {t('bulkDetectExcerptsTitle')}
            </h2>
            <p className="text-xs text-[color:var(--fg-muted)]">
              {t('bulkDetectExcerptsDescription')}
            </p>
          </div>

          {excerptBulkPreviewError !== null && (
            <p className="mb-2 text-xs text-[color:var(--danger)]">
              {t('previewFailed', { message: excerptBulkPreviewError })}
            </p>
          )}

          {excerptBulkPreview !== null && (
            <dl className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-[color:var(--fg-muted)]">
                  {t('unchecked')}
                </dt>
                <dd className="font-mono text-base">
                  {excerptBulkPreview.unchecked}
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">
                  {t('alreadyChecked')}
                </dt>
                <dd className="font-mono text-base">
                  {excerptBulkPreview.alreadyChecked}
                </dd>
              </div>
              <div>
                <dt className="text-[color:var(--fg-muted)]">
                  {t('withoutEmbedding')}
                </dt>
                <dd className="font-mono text-base">
                  {excerptBulkPreview.withoutEmbedding}
                </dd>
              </div>
            </dl>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="excerpt-bulk-limit" className="text-xs text-[color:var(--fg-muted)]">
              {t('limitLabel')}
            </label>
            <input
              id="excerpt-bulk-limit"
              type="number"
              min={1}
              max={BULK_HARD_CAP}
              value={excerptBulkLimit}
              onChange={(e) => {
                const next = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(next)) {
                  setExcerptBulkLimit(Math.max(1, Math.min(next, BULK_HARD_CAP)));
                }
              }}
              className="w-20 rounded border border-[color:var(--border)] bg-transparent px-2 py-1 text-xs"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void triggerExcerptBulkRun()}
              disabled={
                excerptBulkRunning ||
                (excerptBulkPreview !== null && excerptBulkPreview.unchecked === 0)
              }
              busy={excerptBulkRunning}
              busyLabel={t('running')}
            >
              {t('startBulkDetect')}
            </Button>
            {excerptBulkLimit > BULK_CONFIRM_THRESHOLD && (
              <span className="text-[11px] text-[color:var(--warning)]">
                {t('confirmHint', { limit: BULK_CONFIRM_THRESHOLD })}
              </span>
            )}
          </div>

          {excerptBulkError !== null && (
            <p className="mt-3 text-xs text-[color:var(--danger)]">
              {t('runFailed', { message: excerptBulkError })}
            </p>
          )}

          {excerptBulkResult !== null && (
            <div className="mt-3 rounded border border-[color:var(--border)] bg-black/5 p-3 text-xs">
              <p className="mb-2 font-medium">
                {t('resultTitle', { duration: excerptBulkResult.durationMs })}
              </p>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div>
                  <dt className="text-[color:var(--fg-muted)]">scanned</dt>
                  <dd className="font-mono">{excerptBulkResult.scanned}</dd>
                </div>
                <div>
                  <dt className="text-[color:var(--fg-muted)]">checked</dt>
                  <dd className="font-mono">{excerptBulkResult.checked}</dd>
                </div>
                <div>
                  <dt className="text-[color:var(--fg-muted)]">
                    {t('newDuplicates')}
                  </dt>
                  <dd className="font-mono">
                    {excerptBulkResult.excerptMergeCandidatesCreated}
                  </dd>
                </div>
                <div>
                  <dt className="text-[color:var(--fg-muted)]">
                    {t('errors')}
                  </dt>
                  <dd className="font-mono">{excerptBulkResult.failed}</dd>
                </div>
              </dl>
            </div>
          )}
        </section>

        {/* Slice 12 — Status filter for Excerpts */}
        <div className="mb-4 flex flex-wrap gap-2">
          {(['open', 'resolved', 'dismissed', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setExcerptStatusFilter(s)}
              className={[
                'rounded border px-3 py-1 text-xs',
                excerptStatusFilter === s
                  ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
                  : 'border-[color:var(--border)] hover:border-[color:var(--border-strong)]',
              ].join(' ')}
            >
              {s === 'all' ? t('statusAll') : s}
            </button>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadExcerpts()}
            disabled={excerptLoading}
            className="ml-auto"
          >
            {excerptLoading ? t('loading') : t('refresh')}
          </Button>
        </div>

        {excerptError !== null && (
          <div className="mb-4 border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
            {t('error', { message: excerptError })}
          </div>
        )}

        {excerptItems !== null && excerptItems.length === 0 && excerptError === null && (
          <p className="text-sm italic text-[color:var(--fg-muted)]">
            {t('emptyExcerpts')}
          </p>
        )}

        {excerptItems !== null && excerptItems.length > 0 && (
          <ul className="flex flex-col gap-3">
            {[...excerptItems]
              .sort((a, b) => b.props.cosine_sim - a.props.cosine_sim)
              .map((mc) => (
                <li key={mc.id}>
                  <Link
                    href={`/admin/duplicates/excerpt/${encodeURIComponent(mc.id)}`}
                    className="block rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 transition-colors hover:border-[color:var(--accent)]"
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
                      <span
                        className={[
                          'rounded px-2 py-0.5 uppercase tracking-wider',
                          STATUS_BADGE[mc.props.status],
                        ].join(' ')}
                      >
                        {mc.props.status}
                      </span>
                      <span className="rounded bg-[color:var(--warning)]/10 px-2 py-0.5 font-mono uppercase tracking-wider text-[color:var(--warning)]">
                        cosine {mc.props.cosine_sim.toFixed(3)}
                      </span>
                      <time
                        className="font-mono text-[color:var(--fg-muted)]"
                        dateTime={mc.props.created_at}
                      >
                        {new Date(mc.props.created_at).toLocaleString('de-DE')}
                      </time>
                    </div>
                    <p className="text-sm text-[color:var(--fg-strong)]">
                      {mc.excerptA?.props.text?.slice(0, 90) ?? '(Excerpt A)'}
                    </p>
                    <p className="mt-1 text-xs text-[color:var(--fg)]">
                      ↔ {mc.excerptB?.props.text?.slice(0, 90) ?? '(Excerpt B)'}
                    </p>
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </>
      )}
    </main>
  );
}
