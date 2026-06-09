'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';

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

const AXES: ReadonlyArray<{ value: MemoryPurgeAxis; label: string }> = [
  { value: 'all', label: 'Alles' },
  { value: 'agent', label: 'Agent' },
  { value: 'user', label: 'User' },
  { value: 'team', label: 'Team' },
  { value: 'channel', label: 'Channel' },
];

const CONFIRM_ALL = 'DELETE ALL MEMORY';

const SELECTOR_PLACEHOLDER: Record<Exclude<MemoryPurgeAxis, 'all'>, string> = {
  agent: 'de.byte5.agent.calendar',
  user: 'user-id oder Selector',
  team: 'team-id oder Selector',
  channel: 'channel-id oder Selector',
};

export default function DangerZonePage(): React.ReactElement {
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
      setPreviewError('Selector erforderlich für diese Achse.');
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
  }, [axis, requiresSelector, trimmedSelector]);

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
        setDeleteError(
          'Nicht berechtigt (403) — Memory-Purge erfordert Admin-Rechte.',
        );
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
  ]);

  const warning = result?.warning ?? preview?.warning ?? null;

  return (
    <main className="mx-auto max-w-[800px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-red-500">
          Danger Zone · Memory-Purge
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          Löscht Memory unwiderruflich entlang einer Achse. <strong>Alles</strong>{' '}
          wischt Agent-Scratch <em>und</em> Knowledge-Graph; die Achsen
          User / Team / Channel wirken nur im Knowledge-Graph. Es gibt kein
          Undo — immer zuerst die Vorschau prüfen.
        </p>
      </header>

      <section className="mb-6 rounded-[14px] border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-300">
        <p>
          <strong>Hinweis:</strong> Pro User / Team / Channel löschen wirkt nur
          im Knowledge-Graph — der Agent-Scratch ist agent-scoped.
        </p>
        {warning !== null && (
          <p className="mt-2 border-t border-red-500/30 pt-2 font-medium">
            ⚠ {warning}
          </p>
        )}
      </section>

      <section className="mb-6 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Ziel
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-neutral-500">
              Achse
            </span>
            <select
              value={axis}
              onChange={(e) => { onAxisChange(e.target.value as MemoryPurgeAxis); }}
              disabled={deleting}
              className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
            >
              {AXES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>

          {requiresSelector && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wider text-neutral-500">
                Selector
              </span>
              <input
                type="text"
                value={selector}
                onChange={(e) => { onSelectorChange(e.target.value); }}
                placeholder={
                  SELECTOR_PLACEHOLDER[axis as Exclude<MemoryPurgeAxis, 'all'>]
                }
                disabled={deleting}
                className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
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
            Default-Memories nach dem Löschen neu seeden (re-seed defaults)
          </label>
        )}

        <div className="mt-4 flex items-center justify-end">
          <button
            type="button"
            onClick={() => void loadPreview()}
            disabled={
              previewLoading ||
              deleting ||
              (requiresSelector && trimmedSelector.length === 0)
            }
            className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-700"
          >
            {previewLoading ? 'lädt…' : 'Vorschau'}
          </button>
        </div>
      </section>

      {previewError !== null && (
        <section className="mb-6 rounded-[14px] border border-red-400 bg-red-50 p-5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          Vorschau-Fehler: {previewError}
        </section>
      )}

      {preview !== null && previewError === null && (
        <section className="mb-6 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Vorschau — wird gelöscht
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-neutral-500">Agent-Scratch</dt>
            <dd className="font-mono text-red-600 dark:text-red-400">
              {preview.scratchCount}
            </dd>
            <dt className="text-neutral-500">Knowledge-Graph</dt>
            <dd className="font-mono text-red-600 dark:text-red-400">
              {preview.kgCount}
            </dd>
          </dl>
        </section>
      )}

      <section className="mb-6 rounded-[14px] border border-red-500/50 bg-red-500/5 p-5">
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-red-500">
          Löschen bestätigen
        </h2>
        {preview === null ? (
          <p className="text-sm text-[color:var(--fg-muted)]">
            Zuerst eine Vorschau ausführen — Löschen ist erst danach möglich.
          </p>
        ) : requiresSelector && trimmedSelector.length === 0 ? (
          <p className="text-sm text-[color:var(--fg-muted)]">
            Kein Selector gesetzt.
          </p>
        ) : (
          <>
            <p className="mb-2 text-sm text-[color:var(--fg-muted)]">
              Zum Bestätigen exakt eingeben:{' '}
              <code className="rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-red-600 dark:text-red-300">
                {requiredPhrase}
              </code>
            </p>
            <input
              type="text"
              value={confirmInput}
              onChange={(e) => { setConfirmInput(e.target.value); }}
              placeholder={requiredPhrase}
              disabled={deleting}
              className="w-full rounded border border-red-400 px-2 py-1.5 text-sm font-mono dark:border-red-700 dark:bg-neutral-900"
            />
            <div className="mt-4 flex items-center justify-end">
              <button
                type="button"
                onClick={() => void runDelete()}
                disabled={!canDelete}
                className="rounded bg-red-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? 'löscht…' : 'Unwiderruflich löschen'}
              </button>
            </div>
          </>
        )}
      </section>

      {deleteError !== null && (
        <section className="mb-6 rounded-[14px] border border-red-400 bg-red-50 p-5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          Lösch-Fehler: {deleteError}
        </section>
      )}

      {result !== null && (
        <section className="rounded-[14px] border border-emerald-500/40 bg-emerald-500/5 p-5">
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            Gelöscht
          </h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-neutral-500">Agent-Scratch</dt>
            <dd className="font-mono">{result.scratchDeleted}</dd>
            <dt className="text-neutral-500">Knowledge-Graph</dt>
            <dd className="font-mono">{result.kgDeleted}</dd>
          </dl>
        </section>
      )}
    </main>
  );
}
