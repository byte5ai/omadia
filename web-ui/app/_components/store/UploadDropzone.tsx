'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { ApiError, uploadPackage } from '../../_lib/api';
import { parseActivationResult } from '../../_lib/activationError';
import type { UploadedPackage, UploadPackageResponse } from '../../_lib/storeTypes';
import { cn } from '../../_lib/cn';
import { packageErrorText } from '../../_lib/packageErrorText';
import { Button } from '@/app/_components/ui/Button';
import { ActivationFailureNotice } from './ActivationFailureNotice';

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; filename: string; loaded: number; total: number }
  | {
      kind: 'success';
      pkg: UploadedPackage;
      activationError?: ActivationErrorInfo;
      /** #1490 — the version this upload replaced, when it replaced one. */
      replacedVersion?: string;
    }
  // #1455 — `downgrade` carries the refused file back, so the operator can
  // confirm without picking the same zip a second time.
  | { kind: 'error'; code: string; message: string; downgrade?: File };

const ACCEPTED_MIME = 'application/zip,application/x-zip-compressed,.zip';

export function UploadDropzone(): React.ReactElement {
  const t = useTranslations('store.upload');
  const tErr = useTranslations('store.upload.errors');
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const router = useRouter();

  const handleFile = useCallback(
    async (file: File, allowDowngrade = false) => {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        setState({
          kind: 'error',
          code: 'upload.not_zip',
          message: t('onlyZip', { name: file.name }),
        });
        return;
      }
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setState({
        kind: 'uploading',
        filename: file.name,
        loaded: 0,
        total: file.size,
      });

      try {
        const resp = await uploadPackage(file, {
          signal: ctrl.signal,
          onProgress: (loaded, total) => {
            setState({ kind: 'uploading', filename: file.name, loaded, total });
          },
          ...(allowDowngrade ? { allowDowngrade: true } : {}),
        });
        setState({
          kind: 'success',
          pkg: resp.package,
          // #1452 — the ingest succeeded and the plugin that was running did
          // not come back up. Still the success panel (the package IS in the
          // catalog), with the reason named — reporting this as a clean upload
          // is what left operators with a green panel over a dead plugin.
          // #1456 — classified when the middleware sends the shared result.
          ...((): { activationError?: ActivationErrorInfo } => {
            const activationError = activationErrorOf(resp);
            return activationError ? { activationError } : {};
          })(),
          ...(resp.replaced_version ? { replacedVersion: resp.replaced_version } : {}),
        });
        router.refresh();
      } catch (err) {
        if (err instanceof ApiError) {
          const parsed = parseErrorBody(err.body);
          const code = parsed.code ?? `http.${err.status}`;
          setState({
            kind: 'error',
            code,
            message: packageErrorText(
              code,
              parsed.params,
              parsed.message ?? err.message,
              tErr,
            ),
            // Only the downgrade refusal is retryable as-is: every other code
            // means the zip itself has to change.
            ...(code === 'package.downgrade_blocked' ? { downgrade: file } : {}),
          });
        } else {
          setState({
            kind: 'error',
            code: 'upload.unknown',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    [router, t, tErr],
  );

  const onDrop = useCallback(
    (ev: React.DragEvent<HTMLDivElement>) => {
      ev.preventDefault();
      setDragging(false);
      const file = ev.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onFilePicked = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (file) void handleFile(file);
      ev.target.value = '';
    },
    [handleFile],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({ kind: 'idle' });
  }, []);

  // #1455 — the zip a downgrade refusal sent back, narrowed once so the
  // confirm handler closes over a `File` rather than over the state union.
  const refusedDowngrade = state.kind === 'error' ? state.downgrade : undefined;

  return (
    <section
      className={cn(
        'rounded-lg border border-dashed transition-colors',
        'bg-[color:var(--bg-soft)]',
        dragging
          ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/6'
          : 'border-[color:var(--border-strong)]',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="flex items-start gap-4 px-6 py-4">
        <div
          className={cn(
            'flex h-12 w-12 flex-none items-center justify-center rounded-full',
            'bg-[color:var(--bg)] text-[color:var(--accent)] ring-1 ring-[color:var(--border)]',
          )}
          aria-hidden
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
          >
            <path d="M12 3v12" />
            <path d="m7 8 5-5 5 5" />
            <path d="M5 21h14" />
          </svg>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--accent)]">
            <span>Upload</span>
            <span className="h-px flex-1 bg-[color:var(--divider)]" />
            <span className="font-mono-num text-[color:var(--fg-subtle)]">
              .zip
            </span>
          </div>

          <h2 className="font-display mt-3 text-[22px] leading-tight text-[color:var(--fg-strong)]">
            {t('title')}
          </h2>

          <p className="mt-2 text-sm leading-relaxed text-[color:var(--fg-muted)]">
            {t.rich('intro', {
              mono: (chunks) => (
                <span className="font-mono-num text-[color:var(--fg)]">
                  {chunks}
                </span>
              ),
            })}
          </p>

          {state.kind === 'idle' && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                pill
                onClick={() => fileInputRef.current?.click()}
              >
                {t('chooseFile')}
              </Button>
              <span className="text-[12px] text-[color:var(--fg-subtle)]">
                {t('orDragDrop')}
              </span>
            </div>
          )}

          {state.kind === 'uploading' && (
            <UploadingRow
              filename={state.filename}
              loaded={state.loaded}
              total={state.total}
              onCancel={reset}
            />
          )}

          {state.kind === 'success' && (
            <SuccessRow
              pkg={state.pkg}
              onDismiss={reset}
              {...(state.activationError ? { activationError: state.activationError } : {})}
              {...(state.replacedVersion ? { replacedVersion: state.replacedVersion } : {})}
            />
          )}

          {state.kind === 'error' && (
            <ErrorRow
              code={state.code}
              message={state.message}
              onDismiss={reset}
              {...(refusedDowngrade
                ? {
                    onConfirmDowngrade: () => {
                      void handleFile(refusedDowngrade, true);
                    },
                  }
                : {})}
            />
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_MIME}
            className="hidden"
            onChange={onFilePicked}
          />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function UploadingRow({
  filename,
  loaded,
  total,
  onCancel,
}: {
  filename: string;
  loaded: number;
  total: number;
  onCancel: () => void;
}): React.ReactElement {
  const t = useTranslations('store.upload');
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-baseline justify-between gap-4 text-[12px]">
        <span className="font-mono-num truncate text-[color:var(--fg)]">
          {filename}
        </span>
        <span className="font-mono-num tabular-nums text-[color:var(--fg-subtle)]">
          {humanBytes(loaded)} / {humanBytes(total)} · {pct}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--bg)]">
        <div
          className="h-full bg-[color:var(--accent)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare text, no border/bg) */}
      <button
        type="button"
        onClick={onCancel}
        className="text-[12px] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)]"
      >
        {t('cancel')}
      </button>
    </div>
  );
}

interface ActivationErrorInfo {
  code: unknown;
  detail: string | null;
}

/** The re-activation failure of an upload, from the shared `activation` result
 *  or — on an older middleware — the bare `activation_error` string. */
function activationErrorOf(resp: UploadPackageResponse): ActivationErrorInfo | null {
  const activation = parseActivationResult(resp.activation);
  if (activation?.state === 'errored') {
    return { code: activation.error_code, detail: activation.error };
  }
  // `activation_error` is the hook's first-hand verdict. It wins even over an
  // `active` read-back: a registry write that failed after the throw leaves
  // the entry reading `active` over a plugin that did not start.
  return resp.activation_error ? { code: undefined, detail: resp.activation_error } : null;
}

function SuccessRow({
  pkg,
  onDismiss,
  activationError,
  replacedVersion,
}: {
  pkg: UploadedPackage;
  onDismiss: () => void;
  /** #1452 — set when the re-activation of the already-running plugin threw. */
  activationError?: ActivationErrorInfo;
  /** #1490 — set when this upload replaced another version of the package. */
  replacedVersion?: string;
}): React.ReactElement {
  const t = useTranslations('store.upload');
  return (
    <div className="mt-4 rounded-md border border-[color:var(--success,#2a8a5f)]/40 bg-[color:var(--success,#2a8a5f)]/6 px-4 py-3">
      <div className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--success,#2a8a5f)]">
        <span>{t('uploadedKicker')}</span>
        <span className="h-px flex-1 bg-[color:var(--success,#2a8a5f)]/30" />
      </div>
      <p className="mt-2 text-sm text-[color:var(--fg-strong)]">
        {t.rich('inCatalog', {
          id: pkg.id,
          version: pkg.version,
          idTag: (chunks) => <span className="font-mono-num">{chunks}</span>,
          versionTag: (chunks) => (
            <span className="text-[color:var(--fg-muted)]">{chunks}</span>
          ),
        })}
      </p>
      {replacedVersion ? (
        <p className="mt-1 text-[12px] text-[color:var(--fg-muted)]">
          {t('replacedVersion', { previous: replacedVersion })}
        </p>
      ) : null}
      <dl className="mt-2 grid grid-cols-3 gap-x-4 text-[11px] text-[color:var(--fg-muted)]">
        <Metric
          label={t('sizeLabel')}
          value={`${humanBytes(pkg.zip_bytes)} → ${humanBytes(pkg.extracted_bytes)}`}
        />
        <Metric label="Files" value={String(pkg.file_count)} />
        <Metric label="sha256" value={pkg.sha256.slice(0, 10)} mono />
      </dl>
      {pkg.peers_missing.length > 0 && (
        <p className="mt-3 text-[12px] text-[color:var(--warning,#b97a00)]">
          {t('peersMissing', { peers: pkg.peers_missing.join(', ') })}
        </p>
      )}
      {activationError ? (
        <ActivationFailureNotice
          className="mt-3"
          lead={t('activationFailedLead')}
          code={activationError.code}
          detail={activationError.detail}
        />
      ) : null}
      <div className="mt-3 flex gap-3">
        {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare text, no border/bg) */}
        <button
          type="button"
          onClick={onDismiss}
          className="text-[12px] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)]"
        >
          {t('close')}
        </button>
      </div>
    </div>
  );
}

function ErrorRow({
  code,
  message,
  onDismiss,
  onConfirmDowngrade,
}: {
  code: string;
  message: string;
  onDismiss: () => void;
  /** #1455 — present only for `package.downgrade_blocked`: re-sends the zip
   *  that was refused, with the operator's consent. */
  onConfirmDowngrade?: () => void;
}): React.ReactElement {
  const t = useTranslations('store.upload');
  return (
    <div className="mt-4 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 px-4 py-3">
      <div className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--danger)]">
        <span>{t('failedKicker')}</span>
        <span className="h-px flex-1 bg-[color:var(--danger)]/30" />
        <span className="font-mono-num tracking-normal normal-case">
          {code}
        </span>
      </div>
      <p className="mt-2 text-sm text-[color:var(--fg-strong)]">{message}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {onConfirmDowngrade && (
          <Button variant="secondary" pill onClick={onConfirmDowngrade}>
            {t('confirmDowngrade')}
          </Button>
        )}
        {/* eslint-disable-next-line no-restricted-syntax -- inline text link (bare text, no border/bg) */}
        <button
          type="button"
          onClick={onDismiss}
          className="text-[12px] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)]"
        >
          {t('reset')}
        </button>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div>
      <dt className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        {label}
      </dt>
      <dd
        className={cn(
          'mt-0.5 text-[12px] text-[color:var(--fg)]',
          mono && 'font-mono-num',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function parseErrorBody(body: string): {
  code?: string;
  message?: string;
  params?: Record<string, string>;
} {
  try {
    const parsed = JSON.parse(body) as {
      code?: string;
      message?: string;
      params?: unknown;
    };
    const params =
      parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params)
        ? Object.fromEntries(
            Object.entries(parsed.params as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          )
        : undefined;
    return {
      ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
      ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
      ...(params ? { params } : {}),
    };
  } catch {
    return {};
  }
}
