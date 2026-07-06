'use client';

import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

import {
  ApiError,
  previewBulkPromote,
  runBulkPromote,
  type BulkPromotePreview,
  type BulkPromoteRunResult,
} from '../../_lib/api';

const COST_CONFIRM_THRESHOLD = 50;

/**
 * Slice 8 — operator surface for the retrospective bulk-promotion job.
 * Pre-flight pulls counts via GET /preview (cheap, no LLM); trigger
 * runs both phases sync. Above 50 score-calls a confirm dialog
 * surfaces the rough Anthropic spend so accidental clicks can't burn
 * through hundreds of Haiku calls.
 */
export default function BulkPromotePage(): React.ReactElement {
  const t = useTranslations('adminBulkPromote');
  const [threshold, setThreshold] = useState(0.7);
  const [scoreLimit, setScoreLimit] = useState(100);
  const [promoteLimit, setPromoteLimit] = useState(100);

  const [preview, setPreview] = useState<BulkPromotePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BulkPromoteRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const loadPreview = useCallback(async (): Promise<void> => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const p = await previewBulkPromote(threshold);
      setPreview(p);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [threshold]);

  useEffect(() => {
    queueMicrotask(() => void loadPreview());
  }, [loadPreview]);

  const trigger = useCallback(async (): Promise<void> => {
    if (
      scoreLimit > COST_CONFIRM_THRESHOLD &&
      !window.confirm(
        t('confirmRun', {
          count: scoreLimit,
          cost: (scoreLimit * 0.02).toFixed(2),
        }),
      )
    ) {
      return;
    }
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const r = await runBulkPromote({ scoreLimit, promoteLimit, threshold });
      setResult(r);
      void loadPreview();
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setRunError(t('noScorerError'));
      } else {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
    }
  }, [scoreLimit, promoteLimit, threshold, loadPreview, t]);

  return (
    <main className="mx-auto max-w-[800px] px-6 py-12 lg:px-8 lg:py-16">
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

      <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('previewTitle')}
        </h2>
        {previewLoading && (
          <p className="text-xs text-[color:var(--fg-muted)]">{t('loading')}</p>
        )}
        {previewError !== null && (
          <p className="border-l-2 border-[color:var(--danger-edge)] px-2 py-1 text-xs text-[color:var(--danger)]">
            {t('error', { message: previewError })}
          </p>
        )}
        {preview !== null && previewError === null && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[color:var(--fg-muted)]">
              {t('turnsWithoutSignificance')}
            </dt>
            <dd className="font-mono">{preview.nullSignificanceCount}</dd>
            <dt className="text-[color:var(--fg-muted)]">
              {t('eligibleForPromotion', {
                threshold: preview.threshold.toFixed(2),
              })}
            </dt>
            <dd className="font-mono">{preview.eligibleForPromoteCount}</dd>
            <dt className="text-[color:var(--fg-muted)]">
              {t('alreadyPromoted')}
            </dt>
            <dd className="font-mono">{preview.alreadyPromotedCount}</dd>
            <dt className="text-[color:var(--fg-muted)]">
              {t('scorerAvailable')}
            </dt>
            <dd>
              {preview.scorerAvailable ? (
                <span className="text-[color:var(--success)]">✓</span>
              ) : (
                <span className="text-[color:var(--warning)]">
                  {t('scorerUnavailable')}
                </span>
              )}
            </dd>
          </dl>
        )}
      </section>

      <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('parametersTitle')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('thresholdLabel')}
            </span>
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              disabled={running}
              className="rounded border border-[color:var(--border)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('scoreLimitLabel')}
            </span>
            <input
              type="number"
              min="1"
              max="1000"
              value={scoreLimit}
              onChange={(e) => setScoreLimit(Number(e.target.value))}
              disabled={running}
              className="rounded border border-[color:var(--border)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('promoteLimitLabel')}
            </span>
            <input
              type="number"
              min="1"
              max="1000"
              value={promoteLimit}
              onChange={(e) => setPromoteLimit(Number(e.target.value))}
              disabled={running}
              className="rounded border border-[color:var(--border)] px-2 py-1 text-sm"
            />
          </label>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadPreview()}
            disabled={running || previewLoading}
          >
            {t('refreshPreview')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void trigger()}
            disabled={running || preview === null || !preview.scorerAvailable}
            busy={running}
            busyLabel={t('running')}
          >
            {t('startRun')}
          </Button>
        </div>
      </section>

      {runError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {runError}
        </section>
      )}

      {result !== null && (
        <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('resultTitle', { duration: result.durationMs })}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                {t('scorePhaseTitle')}
              </h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-[color:var(--fg-muted)]">scanned</dt>
                <dd className="font-mono">{result.scorePhase.scanned}</dd>
                <dt className="text-[color:var(--fg-muted)]">scored</dt>
                <dd className="font-mono text-[color:var(--success)]">
                  {result.scorePhase.scored}
                </dd>
                <dt className="text-[color:var(--fg-muted)]">failed</dt>
                <dd className="font-mono text-[color:var(--warning)]">
                  {result.scorePhase.failed}
                </dd>
              </dl>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                {t('promotePhaseTitle')}
              </h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-[color:var(--fg-muted)]">scanned</dt>
                <dd className="font-mono">{result.promotePhase.scanned}</dd>
                <dt className="text-[color:var(--fg-muted)]">promoted</dt>
                <dd className="font-mono text-[color:var(--success)]">
                  {result.promotePhase.promoted}
                </dd>
                <dt className="text-[color:var(--fg-muted)]">already</dt>
                <dd className="font-mono">{result.promotePhase.alreadyPromoted}</dd>
                <dt className="text-[color:var(--fg-muted)]">below</dt>
                <dd className="font-mono">{result.promotePhase.belowThreshold}</dd>
                <dt className="text-[color:var(--fg-muted)]">failed</dt>
                <dd className="font-mono text-[color:var(--warning)]">
                  {result.promotePhase.failed}
                </dd>
              </dl>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
