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
  type MemoryPurgeWarning,
} from '../../_lib/api';

/**
 * Admin → Danger Zone (memory purge).
 *
 * Two-stage destructive surface for wiping memory along an axis:
 *   - 'all'     → agent scratch + KG remembered facts + KG conversation history
 *   - 'agent'   → the agent's scratch trees + its KG facts and conversations
 *   - 'user'    → /memories/contexts/<any-agent>/user/<ctxKey>, or — for an
 *                 omadia user id — that person's member notes, KG facts and turns
 *   - 'team' | 'channel'
 *               → /memories/contexts/<any-agent>/<axis>/<ctxKey> only (the KG
 *                 has no team/channel scoping yet)
 *
 * Selector semantics for the three context axes changed with the chat-context
 * memory ACL (design #870 §7). The value must ALWAYS carry a channel-type half:
 * either the context key copied out of the memory browser
 * (`<channelType>~<safeKey>`) or the channel type plus the platform's raw
 * native id. A selector without a `~` is refused by the backend with
 * `invalid_selector` rather than quietly matching nothing — which is why the
 * placeholders and hints spell the format out and say "never a bare id".
 *
 * It is also no longer a KG-only selector: these axes now delete scratch memory
 * too, across every agent that holds the named context.
 *
 * Flow: pick axis (+ selector) → Vorschau (POST /preview, dry-run counts)
 * → type the confirm phrase → Löschen (DELETE /, irreversible). The delete
 * button stays disabled until a successful preview exists AND the typed
 * confirm string matches the required phrase exactly. The server enforces the
 * preview too: the delete carries the preview's token, which only arms that
 * exact selection (#1336). A preview that found nothing offers no delete.
 *
 * Server warnings and errors arrive as codes and are translated here
 * (`warnings.*`, `errors.*`); an unknown error code falls back to the server's
 * own message rather than a bare status line (#1333).
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

// Server codes with copy under `adminDangerZone.warnings.*` / `.errors.*`.
const WARNING_CODES: ReadonlySet<string> = new Set([
  'kg_not_modelled',
  'kg_history_unsupported',
  'user_axis_kg_only',
  'user_axis_scratch_only',
  'audit_unavailable',
  'audit_update_failed',
  'reseed_failed',
]);
const ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_selector',
  'selector_required',
  'preview_required',
  'confirmation_mismatch',
  'audit_write_failed',
]);

const codeRich = {
  code: (chunks: React.ReactNode) => (
    <code className="font-mono text-[color:var(--danger)]">{chunks}</code>
  ),
};

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

  // The re-seed changes what the purge deletes, so it invalidates the preview
  // like any other targeting change (#1335).
  const onReseedChange = useCallback(
    (next: boolean): void => {
      setReseed(next);
      resetStaging();
    },
    [resetStaging],
  );

  /** Localized text for a failed call: copy keyed on the server's code, else
   *  the server's own message, else the bare status line. */
  const describeError = useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        if (err.status === 403) return t('forbiddenError');
        if (err.code !== null && ERROR_CODES.has(err.code)) return t(`errors.${err.code}`);
        if (err.serverMessage !== null) return err.serverMessage;
      }
      return err instanceof Error ? err.message : String(err);
    },
    [t],
  );

  const describeWarning = useCallback(
    (w: MemoryPurgeWarning): string =>
      WARNING_CODES.has(w.code) ? t(`warnings.${w.code}`, w.params ?? {}) : w.code,
    [t],
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
          : { axis, reseed },
      );
      setPreview(p);
    } catch (err) {
      setPreviewError(describeError(err));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [axis, describeError, requiresSelector, reseed, trimmedSelector, t]);

  const confirmMatches = useMemo(
    () => requiredPhrase.length > 0 && confirmInput === requiredPhrase,
    [confirmInput, requiredPhrase],
  );

  const nothingToDelete =
    preview !== null &&
    preview.scratchCount + preview.kgCount + preview.conversationCount === 0;

  const canDelete = preview !== null && !nothingToDelete && confirmMatches && !deleting;

  const runDelete = useCallback(async (): Promise<void> => {
    if (!confirmMatches || preview === null) return;
    setDeleting(true);
    setDeleteError(null);
    setResult(null);
    try {
      const r = await purgeMemory({
        axis,
        ...(requiresSelector ? { selector: trimmedSelector } : {}),
        confirm: requiredPhrase,
        previewToken: preview.previewToken,
        ...(axis === 'all' ? { reseed } : {}),
      });
      setResult(r);
      // A successful purge invalidates the preview counts — force a re-preview
      // before another delete can be armed.
      setPreview(null);
      setConfirmInput('');
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setDeleting(false);
    }
  }, [
    axis,
    confirmMatches,
    describeError,
    preview,
    requiredPhrase,
    requiresSelector,
    reseed,
    trimmedSelector,
  ]);

  const warnings = (result ?? preview)?.warnings ?? [];

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
            ...codeRich,
          })}
        </p>
        {warnings.map((w) => (
          <p
            key={w.code}
            className="mt-2 border-t border-[color:var(--danger-edge)]/30 pt-2 font-medium"
          >
            ⚠ {describeWarning(w)}
          </p>
        ))}
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
                className="rounded border border-[color:var(--border)] px-2 py-1 font-mono text-sm"
              />
              <span className="text-[11px] text-[color:var(--fg-muted)]">
                {t.rich(`selectorHint.${axis}`, codeRich)}
              </span>
            </label>
          )}
        </div>

        {axis === 'all' && (
          <div className="mt-4 text-sm text-[color:var(--fg-muted)]">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={reseed}
                onChange={(e) => { onReseedChange(e.target.checked); }}
                disabled={deleting}
              />
              {t('reseedLabel')}
            </label>
            <p className="mt-1 pl-6 text-[11px]">{t('reseedHint')}</p>
          </div>
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
            <dt className="text-[color:var(--fg-muted)]">
              {t('conversationHistory')}
            </dt>
            <dd className="font-mono text-[color:var(--danger)]">
              {preview.conversationCount}
            </dd>
          </dl>
          {preview.reseedEntries.length > 0 && (
            <p className="mt-2 text-sm text-[color:var(--fg-muted)]">
              {t('reseedPreview', { entries: preview.reseedEntries.join(', ') })}
            </p>
          )}
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
        ) : nothingToDelete ? (
          <p className="text-sm text-[color:var(--fg-muted)]">
            {t('nothingToDelete')}
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
            <dt className="text-[color:var(--fg-muted)]">
              {t('conversationHistory')}
            </dt>
            <dd className="font-mono">{result.conversationDeleted}</dd>
          </dl>
          {result.reseededFiles !== undefined && (
            <p className="mt-2 text-sm text-[color:var(--fg-muted)]">
              {t('reseeded', { count: result.reseededFiles })}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
