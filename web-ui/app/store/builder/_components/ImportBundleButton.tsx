'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileArchive } from 'lucide-react';

import { ApiError, importProfileBundle } from '../../../_lib/api';
import type { ImportBundleSuccess } from '../../../_lib/profileTypes';
import { cn } from '../../../_lib/cn';

/**
 * Phase 2.4 (OB-66) — Bundle-Import-Button + Drag-Drop-Modal.
 *
 * Sits next to "Neuer Agent" on the Builder dashboard. Operator drops a
 * Profile-Bundle ZIP onto the modal; we POST it to
 * `/api/v1/profiles/import-bundle`, which materialises a fresh Builder
 * Draft and redirects to its detail view.
 *
 * Errors surface inline with the BundleImporter error code + a short
 * human-readable hint so operators can decide whether to fix the bundle
 * or install missing plugins before retrying.
 */
export function ImportBundleButton(): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-semibold',
          'border border-[color:var(--border)] bg-[color:var(--bg-soft)] text-[color:var(--fg)]',
          'transition-colors duration-[var(--dur-base)]',
          'hover:bg-[color:var(--gray-100)] hover:text-[color:var(--fg-strong)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]',
        )}
      >
        <Upload className="size-4" aria-hidden />
        Bundle importieren
      </button>
      {open ? (
        <ImportBundleModal
          onClose={() => setOpen(false)}
          onImported={(result) => {
            setOpen(false);
            if (result.draft_id) {
              router.push(`/store/builder/${result.draft_id}`);
            } else {
              router.refresh();
            }
          }}
        />
      ) : null}
    </>
  );
}

interface ImportBundleModalProps {
  onClose: () => void;
  onImported: (result: ImportBundleSuccess) => void;
}

function ImportBundleModal({
  onClose,
  onImported,
}: ImportBundleModalProps): React.ReactElement {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [dragHover, setDragHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onSelectFile = useCallback((picked: File | null) => {
    setError(null);
    setErrorCode(null);
    if (!picked) {
      setFile(null);
      return;
    }
    if (!picked.name.toLowerCase().endsWith('.zip')) {
      setError('Bundle muss eine .zip-Datei sein.');
      setFile(null);
      return;
    }
    setFile(picked);
  }, []);

  const onSubmit = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      const result = await importProfileBundle(file, { overwrite });
      onImported(result);
    } catch (err) {
      if (err instanceof ApiError) {
        try {
          const body = JSON.parse(err.body) as {
            code?: string;
            message?: string;
            diverged_assets?: string[];
          };
          if (body.code === 'bundle.import_conflict') {
            setErrorCode(body.code);
            const list = body.diverged_assets?.join(', ') ?? '';
            setError(
              `Profile hat bereits abweichenden Live-Content (${list}). Aktiviere „Überschreiben" um zu ersetzen.`,
            );
          } else {
            setErrorCode(body.code ?? null);
            setError(body.message ?? err.message);
          }
        } catch {
          setError(err.message);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }, [file, overwrite, onImported]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-6"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-5 text-[color:var(--fg)] shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[color:var(--fg-strong)]">
            Bundle importieren
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xl leading-none text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
            aria-label="Schließen"
          >
            ×
          </button>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-[color:var(--fg-muted)]">
          Drop eine Profile-Bundle-ZIP (Export aus dem Versionen-Tab via{' '}
          <span className="font-mono-num">?format=bundle</span>) hier rein —
          wir legen automatisch einen neuen Draft an.
        </p>

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragHover(true);
          }}
          onDragLeave={() => setDragHover(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragHover(false);
            const dropped = e.dataTransfer.files[0];
            onSelectFile(dropped ?? null);
          }}
          className={cn(
            'flex w-full flex-col items-center justify-center gap-2 rounded-md',
            'border-2 border-dashed p-8 text-center transition-colors',
            dragHover
              ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/5'
              : 'border-[color:var(--border)] bg-[color:var(--bg-soft)] hover:bg-[color:var(--bg)]',
          )}
        >
          <FileArchive
            className="size-7 text-[color:var(--fg-muted)]"
            aria-hidden
          />
          {file ? (
            <>
              <span className="text-sm font-medium text-[color:var(--fg-strong)]">
                {file.name}
              </span>
              <span className="text-[11px] text-[color:var(--fg-subtle)]">
                {Math.round(file.size / 1024)} KB
              </span>
            </>
          ) : (
            <>
              <span className="text-sm text-[color:var(--fg)]">
                ZIP hierher ziehen oder klicken
              </span>
              <span className="text-[11px] text-[color:var(--fg-subtle)]">
                max. 50 MB
              </span>
            </>
          )}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => onSelectFile(e.target.files?.[0] ?? null)}
        />

        {errorCode === 'bundle.import_conflict' ? (
          <label className="mt-3 flex items-start gap-2 text-sm text-[color:var(--fg)]">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Vorhandene Live-Inhalte überschreiben (nur sinnvoll bei Profile-
              Targets — Builder-Drafts sind immer fresh).
            </span>
          </label>
        ) : null}

        {error ? (
          <div className="mt-3 rounded-md border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 p-3 text-xs text-[color:var(--danger)]">
            <p>{error}</p>
            {errorCode ? (
              <p className="mt-1 font-mono-num text-[10px] opacity-70">
                {errorCode}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-sm text-[color:var(--fg)]"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={!file || busy}
            className={cn(
              'rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-sm font-medium text-white',
              'shadow-[var(--shadow-cta)] disabled:opacity-50',
            )}
          >
            {busy ? 'Importiere…' : 'Importieren'}
          </button>
        </div>
      </div>
    </div>
  );
}
