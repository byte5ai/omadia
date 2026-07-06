'use client';

import { useCallback, useMemo, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

import {
  ApiError,
  previewMemoryPurge,
  purgeMemory,
  type MemoryPurgeAxis,
  type MemoryPurgePreviewResult,
  type MemoryPurgeResult,
} from '../../_lib/api';

/**
 * Admin → Danger Zone (memory purge).
 *
 * Two-stage destructive surface for wiping memory along an axis:
 *   - 'all'                       → Agent-Scratch + Knowledge-Graph
 *   - 'agent' | 'user' | 'team' | 'channel' → Knowledge-Graph only
 *
 * Flow: pick axis (+ selector) → Vorschau (POST /preview, dry-run counts)
 * → type the confirm phrase → Löschen (DELETE /, irreversible). The delete
 * button stays disabled until a successful preview exists AND the typed
 * confirm string matches the required phrase exactly.
 *
 * Backed by `/bot-api/v1/admin/memory/purge{/preview}` (cookie-session auth,
 * same admin router as bulk-promote / inconsistencies).
 */

// Stable axis keys — labels and selector placeholders are translated at
// render via `adminDangerZone.axes.*` / `adminDangerZone.selectorPlaceholder.*`.
const AXES: ReadonlyArray<MemoryPurgeAxis> = [
  'all',
  'agent',
  'user',
  'team',
  'channel',
];

// Literal confirm phrase for axis 'all' — compared with === against the
// operator's input and sent to the backend. Deliberately NOT translated.
const CONFIRM_ALL = 'DELETE ALL MEMORY';

export default function DangerZonePage(): React.ReactElement {
  const t = useTranslations('adminDangerZone');
  const [axis, setAxis] = useState<MemoryPurgeAxis>('all');
  const [selector, setSelector] = useState('');
  const [reseed, setReseed] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');

  const [preview, setPreview] = useState<MemoryPurgePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [result, setResult] = useState<MemoryPurgeResult | null>(null);

  const trimmedSelector = selector.trim();
  const requiresSelector = axis !== 'all';
  const requiredPhrase = axis === 'all' ? CONFIRM_ALL : trimmedSelector;

  // Reset all derived/transient state whenever the targeting changes — a
  // stale preview must never gate a delete against a different axis/selector.
  const resetStaging = useCallback((): void => {
    setPreview(null);
    setPreviewError(null);
    setDeleteError(null);
    setResult(null);
    setConfirmInput('');
  }, []);

  const onAxisChange = useCallback(
    (next: MemoryPurgeAxis): void => {
      setAxis(next);
      if (next === 'all') setSelector('');
      else setReseed(false);
      resetStaging();
    },
    [resetStaging],
  );

  const onSelectorChange = useCallback(
    (next: string): void => {
      setSelector(next);
      resetStaging();
    },
    [resetStaging],
  );

  const loadPreview = useCallback(async (): Promise<void> => {
    if (requiresSelector && trimmedSelector.length === 0) {
      setPreviewError(t('selectorRequired'));
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    setResult(null);
    setConfirmInput('');
    try {
      const p = await previewMemoryPurge(
        requiresSelector
          ? { axis, selector: trimmedSelector }
          : { axis },
      );
      setPreview(p);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [axis, requiresSelector, trimmedSelector, t]);

  const confirmMatches = useMemo(
    () => requiredPhrase.length > 0 && confirmInput === requiredPhrase,
    [confirmInput, requiredPhrase],
  );

  const canDelete = preview !== null && confirmMatches && !deleting;

  const runDelete = useCallback(async (): Promise<void> => {
    if (!confirmMatches) return;
    setDeleting(true);
    setDeleteError(null);
    setResult(null);
    try {
      const r = await purgeMemory({
        axis,
        ...(requiresSelector ? { selector: trimmedSelector } : {}),
        confirm: requiredPhrase,
        ...(axis === 'all' ? { reseed } : {}),
      });
      setResult(r);
      // A successful purge invalidates the preview counts — force a re-preview
      // before another delete can be armed.
      setPreview(null);
      setConfirmInput('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setDeleteError(t('forbiddenError'));
      } else {
        setDeleteError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setDeleting(false);
    }
  }, [
    axis,
    confirmMatches,
    requiredPhrase,
    requiresSelector,
    reseed,
    trimmedSelector,
    t,
  ]);

  const warning = result?.warning ?? preview?.warning ?? null;

  return (
    <main className="mx-auto max-w-[800px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--danger)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t.rich('intro', {
            strong: (chunks) => <strong>{chunks}</strong>,
            em: (chunks) => <em>{chunks}</em>,
          })}
        </p>
      </header>

      <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)]/40 bg-[color:var(--danger)]/5 p-4 text-sm text-[color:var(--danger)]">
        <p>
          {t.rich('note', {
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        {warning !== null && (
          <p className="mt-2 border-t border-[color:var(--danger-edge)]/30 pt-2 font-medium">
            ⚠ {warning}
          </p>
        )}
      </section>

      <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
          {t('targetTitle')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('axisLabel')}
            </span>
            <select
              value={axis}
              onChange={(e) => { onAxisChange(e.target.value as MemoryPurgeAxis); }}
              disabled={deleting}
              className="rounded border border-[color:var(--border)] px-2 py-1 text-sm"
            >
              {AXES.map((a) => (
                <option key={a} value={a}>
                  {t(`axes.${a}`)}
                </option>
              ))}
            </select>
          </label>

          {requiresSelector && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                {t('selectorLabel')}
              </span>
              <input
                type="text"
                value={selector}
                onChange={(e) => { onSelectorChange(e.target.value); }}
                placeholder={t(`selectorPlaceholder.${axis}`)}
                disabled={deleting}
                className="rounded border border-[color:var(--border)] px-2 py-1 text-sm"
              />
            </label>
          )}
        </div>

        {axis === 'all' && (
          <label className="mt-4 flex items-center gap-2 text-sm text-[color:var(--fg-muted)]">
            <input
              type="checkbox"
              checked={reseed}
              onChange={(e) => { setReseed(e.target.checked); }}
              disabled={deleting}
            />
            {t('reseedLabel')}
          </label>
        )}

        <div className="mt-4 flex items-center justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadPreview()}
            disabled={
              previewLoading ||
              deleting ||
              (requiresSelector && trimmedSelector.length === 0)
            }
          >
            {previewLoading ? t('loading') : t('previewButton')}
          </Button>
        </div>
      </section>

      {previewError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {t('previewError', { message: previewError })}
        </section>
      )}

      {preview !== null && previewError === null && (
        <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('previewTitle')}
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[color:var(--fg-muted)]">{t('agentScratch')}</dt>
            <dd className="font-mono text-[color:var(--danger)]">
              {preview.scratchCount}
            </dd>
            <dt className="text-[color:var(--fg-muted)]">
              {t('knowledgeGraph')}
            </dt>
            <dd className="font-mono text-[color:var(--danger)]">
              {preview.kgCount}
            </dd>
          </dl>
        </section>
      )}

      <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)]/50 bg-[color:var(--danger)]/5 p-4">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--danger)]">
          {t('confirmTitle')}
        </h2>
        {preview === null ? (
          <p className="text-sm text-[color:var(--fg-muted)]">
            {t('previewFirst')}
          </p>
        ) : requiresSelector && trimmedSelector.length === 0 ? (
          <p className="text-sm text-[color:var(--fg-muted)]">
            {t('noSelector')}
          </p>
        ) : (
          <>
            <p className="mb-2 text-sm text-[color:var(--fg-muted)]">
              {t.rich('confirmInstruction', {
                phrase: requiredPhrase,
                code: (chunks) => (
                  <code className="rounded bg-[color:var(--danger)]/15 px-2 py-0.5 font-mono text-[color:var(--danger)]">
                    {chunks}
                  </code>
                ),
              })}
            </p>
            <input
              type="text"
              value={confirmInput}
              onChange={(e) => { setConfirmInput(e.target.value); }}
              placeholder={requiredPhrase}
              disabled={deleting}
              className="w-full rounded border border-[color:var(--danger-edge)] px-2 py-2 text-sm font-mono"
            />
            <div className="mt-4 flex items-center justify-end">
              <Button
                variant="danger"
                onClick={() => void runDelete()}
                disabled={!canDelete}
              >
                {deleting ? t('deleting') : t('deleteButton')}
              </Button>
            </div>
          </>
        )}
      </section>

      {deleteError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {t('deleteError', { message: deleteError })}
        </section>
      )}

      {result !== null && (
        <section className="rounded-lg border border-[color:var(--success)]/40 bg-[color:var(--success)]/5 p-4">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--success)]">
            {t('deletedTitle')}
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-[color:var(--fg-muted)]">{t('agentScratch')}</dt>
            <dd className="font-mono">{result.scratchDeleted}</dd>
            <dt className="text-[color:var(--fg-muted)]">
              {t('knowledgeGraph')}
            </dt>
            <dd className="font-mono">{result.kgDeleted}</dd>
          </dl>
        </section>
      )}
    </main>
  );
}
