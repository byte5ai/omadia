'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ApiError, uploadPackage } from '../../_lib/api';
import type { UploadedPackage } from '../../_lib/storeTypes';
import { cn } from '../../_lib/cn';

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; filename: string; loaded: number; total: number }
  | { kind: 'success'; pkg: UploadedPackage }
  | { kind: 'error'; code: string; message: string };

const ACCEPTED_MIME = 'application/zip,application/x-zip-compressed,.zip';

export function UploadDropzone(): React.ReactElement {
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const router = useRouter();

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        setState({
          kind: 'error',
          code: 'upload.not_zip',
          message: `Nur .zip erlaubt, bekommen: ${file.name}`,
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
        });
        setState({ kind: 'success', pkg: resp.package });
        router.refresh();
      } catch (err) {
        if (err instanceof ApiError) {
          const parsed = parseErrorBody(err.body);
          setState({
            kind: 'error',
            code: parsed.code ?? `http.${err.status}`,
            message: parsed.message ?? err.message,
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
    [router],
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

  return (
    <section
      className={cn(
        'rounded-[14px] border border-dashed transition-colors',
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
      <div className="flex items-start gap-5 px-6 py-5">
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
            Neues Agent-Package hochladen.
          </h2>

          <p className="mt-2 text-sm leading-relaxed text-[color:var(--fg-muted)]">
            Zieh ein{' '}
            <span className="font-mono-num text-[color:var(--fg)]">.zip</span>{' '}
            hierher oder wähl es über den Button. Der Server validiert das
            Manifest, prüft Peer-Dependencies und registriert den Agent
            automatisch im Katalog.
          </p>

          {state.kind === 'idle' && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full px-4 py-1.5',
                  'text-[13px] font-semibold',
                  'bg-[color:var(--accent)] text-white shadow-[var(--shadow-cta)]',
                  'hover:brightness-110',
                )}
              >
                Datei wählen
              </button>
              <span className="text-[12px] text-[color:var(--fg-subtle)]">
                oder per Drag & Drop
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
            <SuccessRow pkg={state.pkg} onDismiss={reset} />
          )}

          {state.kind === 'error' && (
            <ErrorRow
              code={state.code}
              message={state.message}
              onDismiss={reset}
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
      <button
        type="button"
        onClick={onCancel}
        className="text-[12px] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)]"
      >
        Abbrechen
      </button>
    </div>
  );
}

function SuccessRow({
  pkg,
  onDismiss,
}: {
  pkg: UploadedPackage;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div className="mt-4 rounded-[10px] border border-[color:var(--success,#2a8a5f)]/40 bg-[color:var(--success,#2a8a5f)]/6 px-4 py-3">
      <div className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--success,#2a8a5f)]">
        <span>✓ Hochgeladen</span>
        <span className="h-px flex-1 bg-[color:var(--success,#2a8a5f)]/30" />
      </div>
      <p className="mt-2 text-sm text-[color:var(--fg-strong)]">
        <span className="font-mono-num">{pkg.id}</span>{' '}
        <span className="text-[color:var(--fg-muted)]">v{pkg.version}</span> ist
        im Katalog. Unten wählen und installieren.
      </p>
      <dl className="mt-2 grid grid-cols-3 gap-x-4 text-[11px] text-[color:var(--fg-muted)]">
        <Metric
          label="Größe"
          value={`${humanBytes(pkg.zip_bytes)} → ${humanBytes(pkg.extracted_bytes)}`}
        />
        <Metric label="Files" value={String(pkg.file_count)} />
        <Metric label="sha256" value={pkg.sha256.slice(0, 10)} mono />
      </dl>
      {pkg.peers_missing.length > 0 && (
        <p className="mt-3 text-[12px] text-[color:var(--warning,#b97a00)]">
          ⚠ Fehlende Peer-Deps: {pkg.peers_missing.join(', ')} — Agent kann zur
          Laufzeit fehlschlagen.
        </p>
      )}
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          onClick={onDismiss}
          className="text-[12px] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)]"
        >
          Schließen
        </button>
      </div>
    </div>
  );
}

function ErrorRow({
  code,
  message,
  onDismiss,
}: {
  code: string;
  message: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div className="mt-4 rounded-[10px] border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 px-4 py-3">
      <div className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--danger)]">
        <span>Upload fehlgeschlagen</span>
        <span className="h-px flex-1 bg-[color:var(--danger)]/30" />
        <span className="font-mono-num tracking-normal normal-case">
          {code}
        </span>
      </div>
      <p className="mt-2 text-sm text-[color:var(--fg-strong)]">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 text-[12px] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)]"
      >
        Zurücksetzen
      </button>
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

function parseErrorBody(body: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as { code?: string; message?: string };
    return {
      ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
      ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    };
  } catch {
    return {};
  }
}
