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
        // Slice 6.5 — persist the verbatim source-snippets so the
        // detail-page can show provenance after page-reloads. Skip
        // when the extractor returned no excerpts (cold-fallback
        // path) — the backend short-circuits empty arrays.
        ...(palaiaExcerpt && palaiaExcerpt.excerpts.length > 0
          ? {
              palaiaExcerpts: {
                texts: palaiaExcerpt.excerpts,
                source: palaiaExcerpt.source,
              },
            }
          : {}),
      });
      setSaved(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [kind, summary, rationale, turnId, palaiaExcerpt, t]);

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
        className="ml-3 rounded border border-[color:var(--border)] px-1.5 py-0.5 text-[11px] text-[color:var(--fg-muted)] transition hover:border-[color:var(--border-strong)] hover:text-[color:var(--fg-strong)]"
        title={t('buttonTitle')}
      >
        {saved !== null ? `✓ ${t('savedShort')}` : t('buttonLabel')}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-memory-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) close();
          }}
        >
          <div className="w-full max-w-lg rounded-lg bg-[color:var(--bg-elevated)] p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2
                  id="save-memory-title"
                  className="text-sm font-medium text-[color:var(--fg-strong)]"
                >
                  {t('dialogTitle')}
                </h2>
                {palaiaExcerpt && (
                  <span
                    className={[
                      'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
                      palaiaExcerpt.source === 'hint'
                        ? 'bg-[color:var(--warning)]/10 text-[color:var(--warning)]'
                        : 'bg-[color:var(--accent)]/10 text-[color:var(--accent)]',
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
                className="text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)] disabled:opacity-50"
                aria-label={t('closeAriaLabel')}
              >
                ✕
              </button>
            </div>

            {saved === null ? (
              <>
                <fieldset className="mb-3">
                  <legend className="mb-1 text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                    {t('kindLabel')}
                  </legend>
                  <div className="flex flex-wrap gap-1.5">
                    {KINDS.map((k) => (
                      <label
                        key={k}
                        className={[
                          'cursor-pointer rounded border px-2 py-1 text-xs transition',
                          kind === k
                            ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
                            : 'border-[color:var(--border)] text-[color:var(--fg)] hover:border-[color:var(--border-strong)]',
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
                  <span className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                    {t('summaryLabel')}
                  </span>
                  <textarea
                    ref={summaryRef}
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    disabled={busy}
                    maxLength={2000}
                    rows={3}
                    className="w-full resize-y rounded border border-[color:var(--border)] px-2 py-1.5 text-sm text-[color:var(--fg-strong)] focus:border-[color:var(--border-strong)] focus:outline-none"
                    placeholder={t('summaryPlaceholder')}
                  />
                  <span className="mt-0.5 block text-right text-[10px] text-[color:var(--fg-muted)]">
                    {summary.length} / 2000
                  </span>
                </label>

                {palaiaExcerpt && palaiaExcerpt.excerpts.length > 0 && (
                  <div className="mb-3">
                    <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                      <span>{t('excerptsLabel')}</span>
                      <span className="text-[10px] normal-case tracking-normal text-[color:var(--fg-subtle)]">
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
                            className="group w-full rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-2 py-1 text-left text-xs text-[color:var(--fg)] transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]/10 disabled:opacity-50"
                            title={t('excerptInsertTitle')}
                          >
                            <span className="mr-1 text-[color:var(--fg-subtle)] group-hover:text-[color:var(--accent)]">
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
                  <span className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                    {t('rationaleLabel')}
                  </span>
                  <textarea
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                    disabled={busy}
                    maxLength={10000}
                    rows={2}
                    className="w-full resize-y rounded border border-[color:var(--border)] px-2 py-1.5 text-sm text-[color:var(--fg-strong)] focus:border-[color:var(--border-strong)] focus:outline-none"
                    placeholder={t('rationalePlaceholder')}
                  />
                </label>

                <div className="mb-3 font-mono text-[10px] text-[color:var(--fg-muted)]">
                  {t('linkedToTurn', { turnId })}
                </div>

                {error !== null && (
                  <div className="mb-3 border-l-2 border-[color:var(--danger-edge)] px-2 py-1 text-xs text-[color:var(--danger)]">
                    {t('errorPrefix')} {error}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    disabled={busy}
                    className="rounded border border-[color:var(--border)] px-3 py-1 text-xs hover:border-[color:var(--border-strong)] disabled:opacity-50"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={busy || summary.trim().length === 0}
                    className="rounded bg-[color:var(--bg-inverse)] px-3 py-1 text-xs text-[color:var(--fg-on-dark)] hover:bg-[color:var(--fg-muted)] disabled:opacity-50"
                  >
                    {busy ? t('saving') : t('save')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-3 border-l-2 border-[color:var(--success)] px-2 py-1.5 text-xs text-[color:var(--fg)]">
                  {t('successHeadline')}
                </div>
                <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                  <dt className="text-[color:var(--fg-muted)]">id</dt>
                  <dd className="text-[color:var(--fg-strong)]">
                    {saved.memorableKnowledgeNodeId}
                  </dd>
                  <dt className="text-[color:var(--fg-muted)]">{t('skippedInvolved')}</dt>
                  <dd>{saved.skippedInvolved}</dd>
                  <dt className="text-[color:var(--fg-muted)]">{t('skippedRequired')}</dt>
                  <dd>{saved.skippedRequired}</dd>
                  <dt className="text-[color:var(--fg-muted)]">{t('skippedDerivedFrom')}</dt>
                  <dd>{saved.skippedDerivedFrom}</dd>
                </dl>
                <div className="flex justify-end gap-2">
                  <a
                    href={`/memories/${encodeURIComponent(saved.memorableKnowledgeNodeId)}`}
                    className="rounded border border-[color:var(--border)] px-3 py-1 text-xs hover:border-[color:var(--border-strong)]"
                  >
                    {t('openDetail')}
                  </a>
                  <button
                    type="button"
                    onClick={close}
                    className="rounded bg-[color:var(--bg-inverse)] px-3 py-1 text-xs text-[color:var(--fg-on-dark)] hover:bg-[color:var(--fg-muted)]"
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
