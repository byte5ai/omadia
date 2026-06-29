'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';

import {
  ApiError,
  createGithubIssue,
  disconnectGithub,
  getGithubIssueStatus,
  pollGithubConnect,
  previewGithubIssue,
  startGithubConnect,
  type CreatedIssue,
  type GithubDeviceStart,
  type GithubIssueStatus,
  type IssueCategory,
} from '../_lib/api';
import { Markdown } from './Markdown';

const CATEGORIES: readonly IssueCategory[] = ['bug', 'feature', 'improvement'];
const MAX_TEXT = 5000;

type Step = 'compose' | 'preview' | 'done';
type BodyTab = 'edit' | 'preview';

/**
 * Global header action: file a GitHub issue without leaving omadia.
 *
 * Flow: pick a category + describe the problem in any language → the
 * operator's primary connected LLM phrases it into a clean English issue
 * → review/edit → file to byte5ai/omadia as the operator's own GitHub
 * account (connected on demand via the device flow).
 *
 * The dialog is portalled to <body>: the app header carries a
 * `backdrop-filter`, which creates a containing block for `position:
 * fixed` descendants — rendering the overlay inline would trap it inside
 * the header strip instead of centering it on the viewport.
 */
export function CreateIssueButton(): React.ReactElement {
  const t = useTranslations('createIssue');
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('compose');
  const [category, setCategory] = useState<IssueCategory>('bug');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [bodyTab, setBodyTab] = useState<BodyTab>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<GithubIssueStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [device, setDevice] = useState<GithubDeviceStart | null>(null);
  const [created, setCreated] = useState<CreatedIssue | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelRef = useRef(false);

  const refreshStatus = useCallback(async (): Promise<GithubIssueStatus | null> => {
    try {
      const next = await getGithubIssueStatus();
      setStatus(next);
      return next;
    } catch {
      // A failed status fetch leaves the connect affordance visible —
      // the create call is still gated server-side, so this is safe.
      return null;
    }
  }, []);

  const stopPolling = useCallback((): void => {
    cancelRef.current = true;
  }, []);

  const reset = useCallback((): void => {
    stopPolling();
    setStep('compose');
    setText('');
    setTitle('');
    setBody('');
    setBodyTab('edit');
    setBusy(false);
    setError(null);
    setConnecting(false);
    setDevice(null);
    setCreated(null);
  }, [stopPolling]);

  // Fetch connection status when the dialog opens; focus the textarea.
  // Defer out of the effect body so the async setState in refreshStatus
  // can't be mistaken for a synchronous cascading render.
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      void refreshStatus();
      textRef.current?.focus();
    });
  }, [open, refreshStatus]);

  // Esc closes (unless mid-request).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  // Stop any in-flight poll loop when the component unmounts.
  useEffect(() => () => stopPolling(), [stopPolling]);

  const close = useCallback((): void => {
    stopPolling();
    setConnecting(false);
    setOpen(false);
  }, [stopPolling]);

  const mapPreviewError = useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        if (err.status === 429) return t('errorRateLimited');
        if (err.status === 503) return t('errorLlm');
        if (err.status === 502) return t('errorReformulate');
      }
      return t('errorGeneric');
    },
    [t],
  );

  const onContinue = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await previewGithubIssue({ text: trimmed, category });
      setTitle(preview.title);
      setBody(preview.body);
      setStep('preview');
    } catch (err) {
      setError(mapPreviewError(err));
    } finally {
      setBusy(false);
    }
  }, [text, category, mapPreviewError]);

  const onCreate = useCallback(async (): Promise<void> => {
    if (!title.trim() || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const issue = await createGithubIssue({
        title: title.trim(),
        body: body.trim(),
        category,
      });
      setCreated(issue);
      setStep('done');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(t('errorNotConnected'));
        void refreshStatus();
      } else {
        setError(t('errorGeneric'));
      }
    } finally {
      setBusy(false);
    }
  }, [title, body, category, t, refreshStatus]);

  const onConnect = useCallback(async (): Promise<void> => {
    setError(null);
    let dc: GithubDeviceStart;
    try {
      dc = await startGithubConnect();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 503
          ? t('notConfigured')
          : t('errorGeneric'),
      );
      return;
    }
    setDevice(dc);
    setConnecting(true);
    cancelRef.current = false;

    // Poll until GitHub returns a terminal status, the code expires, or the
    // operator cancels (close/disconnect/unmount flip cancelRef). Modelled
    // as a self-contained async loop so there is no self-referencing
    // callback to schedule.
    let intervalMs = Math.max(1, dc.interval) * 1000;
    const deadline = Date.now() + dc.expiresIn * 1000;
    const sleep = (ms: number): Promise<void> =>
      new Promise((r) => setTimeout(r, ms));
    void (async () => {
      while (!cancelRef.current && Date.now() < deadline) {
        await sleep(intervalMs);
        if (cancelRef.current) return;
        let res;
        try {
          res = await pollGithubConnect();
        } catch {
          continue;
        }
        if (res.status === 'authorized') {
          setDevice(null);
          setConnecting(false);
          await refreshStatus();
          return;
        }
        if (res.status === 'pending') {
          if (res.interval) intervalMs = res.interval * 1000;
          continue;
        }
        // expired | denied | error
        setDevice(null);
        setConnecting(false);
        setError(
          res.status === 'denied' ? t('deviceDenied') : t('deviceExpired'),
        );
        return;
      }
      if (!cancelRef.current) {
        setDevice(null);
        setConnecting(false);
        setError(t('deviceExpired'));
      }
    })();
  }, [refreshStatus, t]);

  const onDisconnect = useCallback(async (): Promise<void> => {
    stopPolling();
    setConnecting(false);
    setDevice(null);
    try {
      await disconnectGithub();
    } catch {
      // best-effort
    }
    void refreshStatus();
  }, [refreshStatus, stopPolling]);

  const connected = status?.connected ?? false;
  const oauthConfigured = status?.oauthConfigured ?? true;

  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-issue-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-lg bg-[color:var(--bg-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[color:var(--border)] px-4 py-3">
          <h2
            id="create-issue-title"
            className="text-sm font-medium text-[color:var(--fg-strong)]"
          >
            {step === 'done'
              ? t('successTitle')
              : step === 'preview'
                ? t('previewTitle')
                : t('dialogTitle')}
          </h2>
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

        <div className="overflow-y-auto px-4 py-4">
          {/* Connection state — checked on open and always surfaced, so the
              operator can connect up front rather than only at filing time. */}
          {step !== 'done' && (
            <div className="mb-4 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-3 py-2 text-xs">
              {!oauthConfigured ? (
                <span className="text-[color:var(--fg-muted)]">
                  {t('notConfigured')}
                </span>
              ) : connected ? (
                <span className="text-[color:var(--fg-muted)]">
                  {status?.login
                    ? t('connectedAs', { login: status.login })
                    : t('repoNote')}
                  {' · '}
                  <button
                    type="button"
                    onClick={() => void onDisconnect()}
                    className="underline hover:text-[color:var(--fg-strong)]"
                  >
                    {t('disconnect')}
                  </button>
                </span>
              ) : device ? (
                <div className="text-[color:var(--fg)]">
                  <p className="mb-2">
                    {t.rich('deviceStep1', {
                      page: (chunks) => (
                        <a
                          href={device.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[color:var(--accent)] underline hover:text-[color:var(--fg-strong)]"
                        >
                          {chunks}
                        </a>
                      ),
                    })}
                  </p>
                  <p className="mb-1">{t('deviceStep2')}</p>
                  <div className="mb-2 select-all font-mono text-lg font-semibold tracking-[0.3em] text-[color:var(--fg-strong)]">
                    {device.userCode}
                  </div>
                  <p className="text-[11px] text-[color:var(--fg-muted)]">
                    {t('deviceWaiting')}
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[color:var(--fg)]">
                    {t('connectIntro')}
                  </span>
                  <button
                    type="button"
                    onClick={() => void onConnect()}
                    disabled={connecting}
                    className="shrink-0 rounded border border-[color:var(--border-strong)] px-3 py-1 text-[color:var(--fg-strong)] hover:bg-[color:var(--bg-inverse)] hover:text-[color:var(--fg-on-dark)] disabled:opacity-50"
                  >
                    {connecting ? t('connecting') : t('connectGithub')}
                  </button>
                </div>
              )}
            </div>
          )}

          {step === 'compose' && (
            <>
              <fieldset className="mb-4">
                <legend className="mb-1 text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                  {t('categoryLabel')}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {CATEGORIES.map((c) => (
                    <label
                      key={c}
                      className={[
                        'cursor-pointer rounded border px-2.5 py-1 text-xs transition',
                        category === c
                          ? 'border-[color:var(--border-strong)] bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
                          : 'border-[color:var(--border)] text-[color:var(--fg)] hover:border-[color:var(--border-strong)]',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="issue-category"
                        value={c}
                        checked={category === c}
                        onChange={() => setCategory(c)}
                        disabled={busy}
                        className="sr-only"
                      />
                      {t(`category.${c}`)}
                    </label>
                  ))}
                </div>
              </fieldset>

              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                  {t('descriptionLabel')}
                </span>
                <textarea
                  ref={textRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={busy}
                  maxLength={MAX_TEXT}
                  rows={6}
                  className="w-full resize-y rounded border border-[color:var(--border)] px-2 py-2 text-sm text-[color:var(--fg-strong)] focus:border-[color:var(--border-strong)] focus:outline-none"
                  placeholder={t('descriptionPlaceholder')}
                />
                <span className="mt-0.5 block text-right text-[10px] text-[color:var(--fg-muted)]">
                  {text.length} / {MAX_TEXT}
                </span>
              </label>
            </>
          )}

          {step === 'preview' && (
            <>
              <p className="mb-3 text-xs text-[color:var(--fg-muted)]">
                {t('previewHint')}
              </p>
              <label className="mb-3 block">
                <span className="mb-1 block text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                  {t('titleLabel')}
                </span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={busy}
                  maxLength={120}
                  className="w-full rounded border border-[color:var(--border)] px-2 py-2 text-sm text-[color:var(--fg-strong)] focus:border-[color:var(--border-strong)] focus:outline-none"
                />
              </label>
              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                    {t('bodyLabel')}
                  </span>
                  <div className="flex gap-1">
                    {(['edit', 'preview'] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setBodyTab(tab)}
                        className={[
                          'rounded px-2 py-0.5 text-[11px] transition',
                          bodyTab === tab
                            ? 'bg-[color:var(--bg-inverse)] text-[color:var(--fg-on-dark)]'
                            : 'text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]',
                        ].join(' ')}
                      >
                        {tab === 'edit' ? t('tabEdit') : t('tabPreview')}
                      </button>
                    ))}
                  </div>
                </div>
                {bodyTab === 'edit' ? (
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    disabled={busy}
                    maxLength={20000}
                    rows={10}
                    className="w-full resize-y rounded border border-[color:var(--border)] px-2 py-2 font-mono text-xs text-[color:var(--fg-strong)] focus:border-[color:var(--border-strong)] focus:outline-none"
                  />
                ) : (
                  <div className="md-view max-h-[40vh] min-h-[10rem] overflow-y-auto rounded border border-[color:var(--border)] px-3 py-2">
                    {body.trim() ? (
                      <Markdown source={body} />
                    ) : (
                      <span className="text-xs text-[color:var(--fg-muted)]">
                        {t('emptyPreview')}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {step === 'done' && created && (
            <div className="border-l-2 border-[color:var(--success)] px-3 py-2 text-sm text-[color:var(--fg)]">
              <p className="mb-2">
                {t('successTitle')} #{created.number}
              </p>
              <a
                href={created.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-[color:var(--accent)] underline hover:text-[color:var(--fg-strong)]"
              >
                {t('openOnGithub')} ↗
              </a>
            </div>
          )}

          {busy && (
            <div className="mt-4">
              <div
                role="progressbar"
                aria-label={step === 'compose' ? t('reformulating') : t('creating')}
                className="h-1 w-full overflow-hidden rounded-full bg-[color:var(--border)]"
              >
                <div className="h-full w-full animate-pulse rounded-full bg-[color:var(--accent)]" />
              </div>
              <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
                {step === 'compose' ? t('reformulating') : t('creating')}
              </p>
            </div>
          )}

          {error !== null && (
            <div className="mt-3 border-l-2 border-[color:var(--danger-edge)] px-2 py-1 text-xs text-[color:var(--danger)]">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[color:var(--border)] px-4 py-3">
          {step === 'compose' && (
            <>
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
                onClick={() => void onContinue()}
                disabled={busy || text.trim().length === 0}
                className="rounded bg-[color:var(--bg-inverse)] px-3 py-1 text-xs text-[color:var(--fg-on-dark)] hover:bg-[color:var(--fg-muted)] disabled:opacity-50"
              >
                {busy ? t('reformulating') : t('reformulate')}
              </button>
            </>
          )}
          {step === 'preview' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setStep('compose');
                  setError(null);
                }}
                disabled={busy}
                className="rounded border border-[color:var(--border)] px-3 py-1 text-xs hover:border-[color:var(--border-strong)] disabled:opacity-50"
              >
                {t('back')}
              </button>
              <button
                type="button"
                onClick={() => void onCreate()}
                disabled={
                  busy ||
                  !connected ||
                  title.trim().length === 0 ||
                  body.trim().length === 0
                }
                className="rounded bg-[color:var(--bg-inverse)] px-3 py-1 text-xs text-[color:var(--fg-on-dark)] hover:bg-[color:var(--fg-muted)] disabled:opacity-50"
              >
                {busy ? t('creating') : t('create')}
              </button>
            </>
          )}
          {step === 'done' && (
            <>
              <button
                type="button"
                onClick={reset}
                className="rounded border border-[color:var(--border)] px-3 py-1 text-xs hover:border-[color:var(--border-strong)]"
              >
                {t('createAnother')}
              </button>
              <button
                type="button"
                onClick={close}
                className="rounded bg-[color:var(--bg-inverse)] px-3 py-1 text-xs text-[color:var(--fg-on-dark)] hover:bg-[color:var(--fg-muted)]"
              >
                {t('dismiss')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (created !== null) reset();
          setOpen(true);
        }}
        className="rounded p-1.5 text-[color:var(--fg-muted)] transition hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]"
        title={t('button')}
        aria-label={t('button')}
      >
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
        </svg>
      </button>

      {open && createPortal(dialog, document.body)}
    </>
  );
}
