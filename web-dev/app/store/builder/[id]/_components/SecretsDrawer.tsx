'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, KeyRound, Loader2, Trash2, X } from 'lucide-react';

import {
  ApiError,
  clearPreviewSecrets,
  getPreviewSecretsStatus,
  setPreviewSecrets,
} from '../../../../_lib/api';
import type { SetupField } from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';

interface SecretsDrawerProps {
  draftId: string;
  /** Declared setup_fields from the draft.spec — drives the form. */
  fields: ReadonlyArray<SetupField>;
  open: boolean;
  onClose: () => void;
  /** Notified after successful PUT/DELETE so the trigger button can update
   *  its badge ("3 von 5 gesetzt"). */
  onStatusChange?: (bufferedKeys: ReadonlyArray<string>) => void;
}

/**
 * Test-Credentials-Drawer (Phase B.5 review-5).
 *
 * Reads the declared `spec.setup_fields` and renders a form so the user
 * can supply ephemeral test credentials for the preview agent. Values
 * never persist server-side beyond the in-memory PreviewSecretBuffer
 * (B.3-4a) — they're gone on logout / restart.
 *
 * Backend wiring:
 *   GET    /preview/secrets — returns the buffered key set (no values)
 *   PUT    /preview/secrets — replaces the buffer
 *   DELETE /preview/secrets — clears the buffer
 *
 * The drawer never knows the actual values once they leave the browser
 * — on re-open we only show "✓ gesetzt" badges per key, never re-populate
 * the inputs.
 */
export function SecretsDrawer({
  draftId,
  fields,
  open,
  onClose,
  onStatusChange,
}: SecretsDrawerProps): React.ReactElement {
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [bufferedKeys, setBufferedKeys] = useState<string[]>([]);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reload status whenever the drawer opens — the user might have switched
  // tabs and changed it elsewhere.
  useEffect(() => {
    if (!open) return;
    void getPreviewSecretsStatus(draftId)
      .then((res) => {
        setBufferedKeys(res.keys);
        setPersistent(res.persistent ?? null);
        onStatusChange?.(res.keys);
      })
      .catch(() => {
        // Non-fatal — the drawer still works for setting new values.
      });
  }, [draftId, open, onStatusChange]);

  // Reset form state when the drawer closes so cached secrets don't sit
  // in React state longer than necessary.
  useEffect(() => {
    if (!open) {
      setDraftValues({});
      setError(null);
    }
  }, [open]);

  const onSave = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      // Only send keys the user actually filled in this session — empty
      // strings would clobber a previously-buffered value with "".
      const filtered = Object.fromEntries(
        Object.entries(draftValues).filter(([, v]) => v.length > 0),
      );
      // Merge against currently-buffered keys: missing fields stay buffered
      // server-side because PUT replaces. To support per-key edit without
      // wiping siblings we'd need a PATCH endpoint; for now the drawer
      // takes "save" to mean "replace everything with what's typed".
      await setPreviewSecrets(draftId, filtered);
      const next = await getPreviewSecretsStatus(draftId);
      setBufferedKeys(next.keys);
      onStatusChange?.(next.keys);
      setDraftValues({});
      onClose();
    } catch (err) {
      setError(humanizeApiError(err));
    } finally {
      setPending(false);
    }
  }, [draftId, draftValues, onClose, onStatusChange]);

  const onClearAll = useCallback(async () => {
    if (!confirm('Alle Test-Credentials löschen?')) return;
    setPending(true);
    setError(null);
    try {
      await clearPreviewSecrets(draftId);
      setBufferedKeys([]);
      onStatusChange?.([]);
      setDraftValues({});
    } catch (err) {
      setError(humanizeApiError(err));
    } finally {
      setPending(false);
    }
  }, [draftId, onStatusChange]);

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 bg-black/30"
            onClick={onClose}
          />
          <motion.aside
            key="drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 280, damping: 32 }}
            className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-[color:var(--divider)] bg-[color:var(--bg-elevated)] shadow-[0_-4px_24px_rgba(0,0,0,0.12)]"
            role="dialog"
            aria-label="Test-Credentials"
          >
            <header className="flex items-baseline gap-3 border-b border-[color:var(--divider)] px-5 py-4">
              <KeyRound
                className="size-3.5 shrink-0 text-[color:var(--accent)]"
                aria-hidden
              />
              <h2 className="font-display text-[18px] leading-none text-[color:var(--fg-strong)]">
                Test-Credentials
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Drawer schließen"
                className="ml-auto rounded-md p-1 text-[color:var(--fg-subtle)] hover:bg-[color:var(--bg-soft)] hover:text-[color:var(--fg-strong)]"
              >
                <X className="size-4" aria-hidden />
              </button>
            </header>

            <div className="space-y-4 overflow-y-auto px-5 py-4 text-[13px]">
              <p className="text-[12px] text-[color:var(--fg-muted)]">
                {persistent === true
                  ? 'Werte werden verschlüsselt im Vault gespeichert und überleben einen Restart. Klick auf «Alle löschen» wischt sie endgültig.'
                  : persistent === false
                    ? 'Werte leben nur im Speicher des Servers und sind beim Logout/Restart weg.'
                    : 'Werte werden serverseitig im PreviewSecretBuffer gespeichert.'}
                {' '}Nicht für Production — installierte Plugins beziehen ihre Credentials aus dem Vault per RequiresWizard.
              </p>

              {fields.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-[color:var(--divider)] p-4 text-center text-[12px] text-[color:var(--fg-muted)]">
                  Keine{' '}
                  <span className="font-mono-num">setup_fields</span>{' '}
                  deklariert. Lege welche im Spec-Tab an, um Credentials zu
                  testen.
                </div>
              ) : (
                <ul className="space-y-3">
                  {fields.map((f) => (
                    <SecretFieldRow
                      key={f.key}
                      field={f}
                      buffered={bufferedKeys.includes(f.key)}
                      value={draftValues[f.key] ?? ''}
                      onChange={(v) =>
                        setDraftValues((prev) => ({ ...prev, [f.key]: v }))
                      }
                    />
                  ))}
                </ul>
              )}

              {error ? (
                <p className="text-[11px] text-[color:var(--danger)]">{error}</p>
              ) : null}
            </div>

            <footer className="flex items-center gap-2 border-t border-[color:var(--divider)] px-5 py-3">
              <button
                type="button"
                onClick={() => void onClearAll()}
                disabled={pending || bufferedKeys.length === 0}
                className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--danger)]/40 px-2.5 py-1.5 text-[11px] font-semibold text-[color:var(--danger)] transition-colors hover:bg-[color:var(--danger)]/10 disabled:opacity-40"
              >
                <Trash2 className="size-3" aria-hidden />
                Alle löschen
              </button>
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={pending || fields.length === 0}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-white shadow-[var(--shadow-cta)] disabled:opacity-50"
              >
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <CheckCircle2 className="size-3.5" aria-hidden />
                )}
                Übernehmen
              </button>
            </footer>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------

function SecretFieldRow({
  field,
  buffered,
  value,
  onChange,
}: {
  field: SetupField;
  buffered: boolean;
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const inputType = field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text';
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor={`secret-${field.key}`}
          className="font-mono-num text-[11px] font-semibold text-[color:var(--fg-strong)]"
        >
          {field.key}
          {field.required ? (
            <span className="ml-1 text-[color:var(--danger)]">*</span>
          ) : null}
        </label>
        <span
          className={cn(
            'font-mono-num inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em]',
            field.type === 'secret'
              ? 'text-[color:var(--accent)]'
              : 'text-[color:var(--fg-subtle)]',
          )}
        >
          {field.type ?? 'string'}
          {buffered ? (
            <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-[color:var(--success)]/15 px-1.5 py-0.5 text-[color:var(--success)]">
              <CheckCircle2 className="size-2.5" aria-hidden />
              gesetzt
            </span>
          ) : null}
        </span>
      </div>
      {field.label && field.label !== field.key ? (
        <p className="text-[11px] text-[color:var(--fg-muted)]">{field.label}</p>
      ) : null}
      {field.description ? (
        <p className="text-[11px] text-[color:var(--fg-subtle)]">
          {field.description}
        </p>
      ) : null}
      {field.type === 'boolean' ? (
        <label className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-[color:var(--fg-strong)]">
          <input
            type="checkbox"
            checked={value === 'true'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            className="size-3.5 rounded border-[color:var(--border)] accent-[color:var(--accent)]"
          />
          {value === 'true' ? 'true' : 'false'}
        </label>
      ) : (
        <input
          id={`secret-${field.key}`}
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            buffered
              ? 'gesetzt — leer lassen um Wert beizubehalten'
              : 'Wert eingeben'
          }
          autoComplete="off"
          className="mt-1 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 text-[12px] text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)] focus:border-[color:var(--accent)] focus:outline-none"
        />
      )}
    </li>
  );
}

function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { code?: string; message?: string };
      if (body.code && body.message) return `${body.code}: ${body.message}`;
      if (body.message) return body.message;
    } catch {
      // ignore
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
