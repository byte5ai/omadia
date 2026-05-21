'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  createMemory,
  type CreateMemoryResponse,
  type MemorableKind,
} from '../../_lib/api';
import type { PalaiaExcerpt } from '../../_lib/chatSessions';

const KINDS: readonly MemorableKind[] = [
  'decision',
  'insight',
  'preference',
  'reference',
];

const MAX_SUMMARY_PREFILL = 240;

interface Props {
  /** Turn id the orchestrator emitted with the `done` event. Backend
   *  uses it for the DERIVED_FROM edge (skipped if the Turn no longer
   *  exists). */
  turnId: string;
  /** Assistant message content — fallback pre-fill source when
   *  `palaiaExcerpt` is absent. */
  messageContent: string;
  /** Slice 4a — Palaia-Extractor suggestion. When present, the modal
   *  pre-fills kind/summary/rationale from it and renders excerpt
   *  chips as one-click "insert into summary" affordances. */
  palaiaExcerpt?: PalaiaExcerpt;
}

/**
 * Slice 3 polish — lets the signed-in user promote an assistant turn
 * into a curated MemorableKnowledge node. Open question/decision/insight
 * the agent surfaced → one click, choose `kind`, edit `summary`, save.
 *
 * Backend POST /api/v1/memory auto-derives `aclOwners = [session user]`
 * so the saver always owns the resulting MK; the `/memories` list-page
 * will then surface it immediately.
 */
export function SaveMemoryButton({
  turnId,
  messageContent,
  palaiaExcerpt,
}: Props): React.ReactElement {
  const t = useTranslations('chat.saveAsMemory');
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<MemorableKind>(
    palaiaExcerpt?.suggestedKind ?? 'insight',
  );
  const [summary, setSummary] = useState('');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<CreateMemoryResponse | null>(null);
  const summaryRef = useRef<HTMLTextAreaElement | null>(null);

  // Pre-fill from the Palaia-Extractor suggestion when present; fall
  // back to a trimmed slice of the message body. Tied to the dialog
  // open-transition so a re-open without close keeps the user's draft.
  useEffect(() => {
    if (!open) return;
    if (summary.length > 0) {
      // Existing draft — focus only.
      summaryRef.current?.focus();
      return;
    }
    // Defer the state writes + focus out of the effect body: a
    // synchronous setState in an effect triggers a cascading render
    // (lint-flagged).
    queueMicrotask(() => {
      if (palaiaExcerpt) {
        setKind(palaiaExcerpt.suggestedKind);
        setSummary(palaiaExcerpt.suggestedSummary);
        if (palaiaExcerpt.suggestedRationale !== undefined) {
          setRationale(palaiaExcerpt.suggestedRationale);
        }
      } else {
        const cleaned = messageContent.trim().replace(/\s+/g, ' ');
        setSummary(
          cleaned.length > MAX_SUMMARY_PREFILL
            ? `${cleaned.slice(0, MAX_SUMMARY_PREFILL).trimEnd()}…`
            : cleaned,
        );
      }
      summaryRef.current?.focus();
    });
  }, [open, messageContent, palaiaExcerpt, summary.length]);

  // One-click excerpt insertion: append the excerpt as a quoted line
  // to the summary textarea. Caret-position-aware insertion is
  // out-of-scope; appending is good enough for the common "I want
  // this exact sentence in the memory" flow.
  const insertExcerpt = useCallback((excerpt: string): void => {
    setSummary((prev) => {
      const sep = prev.length > 0 && !prev.endsWith('\n') ? '\n' : '';
      return `${prev}${sep}„${excerpt}"`;
    });
    queueMicrotask(() => summaryRef.current?.focus());
  }, []);

  // Allow Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  const reset = useCallback((): void => {
    setKind('insight');
    setSummary('');
    setRationale('');
    setError(null);
    setBusy(false);
    setSaved(null);
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    const trimmedSummary = summary.trim();
    if (trimmedSummary.length === 0) {
      setError(t('summaryRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const trimmedRationale = rationale.trim();
      const res = await createMemory({
        kind,
        summary: trimmedSummary,
        derivedFromTurnIds: [turnId],
        ...(trimmedRationale.length > 0
          ? { rationale: trimmedRationale }
          : {}),
      });
      setSaved(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [kind, summary, rationale, turnId, t]);

  const close = useCallback((): void => {
    setOpen(false);
    // Reset only after the dialog is dismissed so the success toast on
    // the button stays informative until the next open.
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (saved !== null) reset();
          setOpen(true);
        }}
        className="ml-3 rounded border border-neutral-300 px-1.5 py-0.5 text-[11px] text-neutral-600 transition hover:border-neutral-400 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:text-neutral-100"
        title={t('buttonTitle')}
      >
        {saved !== null ? `✓ ${t('savedShort')}` : t('buttonLabel')}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-memory-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) close();
          }}
        >
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2
                  id="save-memory-title"
                  className="text-sm font-medium text-neutral-900 dark:text-neutral-100"
                >
                  {t('dialogTitle')}
                </h2>
                {palaiaExcerpt && (
                  <span
                    className={[
                      'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
                      palaiaExcerpt.source === 'hint'
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                        : 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
                    ].join(' ')}
                    title={t(`source.${palaiaExcerpt.source}Title`)}
                  >
                    {t(`source.${palaiaExcerpt.source}Label`)}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="text-neutral-500 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-100"
                aria-label={t('closeAriaLabel')}
              >
                ✕
              </button>
            </div>

            {saved === null ? (
              <>
                <fieldset className="mb-3">
                  <legend className="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">
                    {t('kindLabel')}
                  </legend>
                  <div className="flex flex-wrap gap-1.5">
                    {KINDS.map((k) => (
                      <label
                        key={k}
                        className={[
                          'cursor-pointer rounded border px-2 py-1 text-xs transition',
                          kind === k
                            ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-200 dark:bg-neutral-200 dark:text-neutral-900'
                            : 'border-neutral-300 text-neutral-700 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500',
                        ].join(' ')}
                      >
                        <input
                          type="radio"
                          name="kind"
                          value={k}
                          checked={kind === k}
                          onChange={() => setKind(k)}
                          disabled={busy}
                          className="sr-only"
                        />
                        {t(`kind.${k}`)}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <label className="mb-3 block">
                  <span className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">
                    {t('summaryLabel')}
                  </span>
                  <textarea
                    ref={summaryRef}
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    disabled={busy}
                    maxLength={2000}
                    rows={3}
                    className="w-full resize-y rounded border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                    placeholder={t('summaryPlaceholder')}
                  />
                  <span className="mt-0.5 block text-right text-[10px] text-neutral-500">
                    {summary.length} / 2000
                  </span>
                </label>

                {palaiaExcerpt && palaiaExcerpt.excerpts.length > 0 && (
                  <div className="mb-3">
                    <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wider text-neutral-500">
                      <span>{t('excerptsLabel')}</span>
                      <span className="text-[10px] normal-case tracking-normal text-neutral-400">
                        {t('excerptsHint')}
                      </span>
                    </div>
                    <ul className="flex flex-col gap-1">
                      {palaiaExcerpt.excerpts.map((excerpt, idx) => (
                        <li key={`${idx}-${excerpt.slice(0, 24)}`}>
                          <button
                            type="button"
                            onClick={() => insertExcerpt(excerpt)}
                            disabled={busy}
                            className="group w-full rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-left text-xs text-neutral-700 transition hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300 dark:hover:border-indigo-700 dark:hover:bg-indigo-900/20"
                            title={t('excerptInsertTitle')}
                          >
                            <span className="mr-1 text-neutral-400 group-hover:text-indigo-400">
                              +
                            </span>
                            {excerpt}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <label className="mb-3 block">
                  <span className="mb-1 block text-[11px] uppercase tracking-wider text-neutral-500">
                    {t('rationaleLabel')}
                  </span>
                  <textarea
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                    disabled={busy}
                    maxLength={10000}
                    rows={2}
                    className="w-full resize-y rounded border border-neutral-300 px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                    placeholder={t('rationalePlaceholder')}
                  />
                </label>

                <div className="mb-3 font-mono text-[10px] text-neutral-500">
                  {t('linkedToTurn', { turnId })}
                </div>

                {error !== null && (
                  <div className="mb-3 border-l-2 border-red-400 px-2 py-1 text-xs text-red-700 dark:text-red-300">
                    {t('errorPrefix')} {error}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    disabled={busy}
                    className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-700 dark:hover:border-neutral-500"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={busy || summary.trim().length === 0}
                    className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                  >
                    {busy ? t('saving') : t('save')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-3 border-l-2 border-green-400 px-2 py-1.5 text-xs text-neutral-700 dark:text-neutral-300">
                  {t('successHeadline')}
                </div>
                <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                  <dt className="text-neutral-500">id</dt>
                  <dd className="text-neutral-900 dark:text-neutral-100">
                    {saved.memorableKnowledgeNodeId}
                  </dd>
                  <dt className="text-neutral-500">{t('skippedInvolved')}</dt>
                  <dd>{saved.skippedInvolved}</dd>
                  <dt className="text-neutral-500">{t('skippedRequired')}</dt>
                  <dd>{saved.skippedRequired}</dd>
                  <dt className="text-neutral-500">{t('skippedDerivedFrom')}</dt>
                  <dd>{saved.skippedDerivedFrom}</dd>
                </dl>
                <div className="flex justify-end gap-2">
                  <a
                    href={`/memories/${encodeURIComponent(saved.memorableKnowledgeNodeId)}`}
                    className="rounded border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
                  >
                    {t('openDetail')}
                  </a>
                  <button
                    type="button"
                    onClick={close}
                    className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                  >
                    {t('close')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
