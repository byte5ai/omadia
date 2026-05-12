'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Loader2, Lock, Trash2 } from 'lucide-react';

import { cn } from '../../_lib/cn';
import {
  configureInstallJob,
  createInstallJob,
  deleteUploadedPackage,
  uninstallPlugin,
  ApiError,
} from '../../_lib/api';
import type {
  InstallChainResolution,
  InstallJob,
  InstallSetupField,
  InstallValidationError,
} from '../../_lib/storeTypes';
import { RequiresWizard } from './RequiresWizard';
import { FieldRow, extractValues } from './setupForm';

interface InstallButtonProps {
  pluginId: string;
  pluginName: string;
  installState: 'available' | 'installed' | 'update-available' | 'incompatible';
  enabled: boolean;
  blockingReasons?: string[];
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'form'; job: InstallJob }
  | { kind: 'submitting'; job: InstallJob; values: Record<string, unknown> }
  | { kind: 'error'; job: InstallJob | null; message: string }
  | { kind: 'wizard'; resolution: InstallChainResolution }
  | { kind: 'success' };

export function InstallButton({
  pluginId,
  pluginName,
  installState,
  enabled,
  blockingReasons,
}: InstallButtonProps): React.ReactElement {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string>
  >({});

  const drawerOpen =
    phase.kind === 'form' ||
    phase.kind === 'submitting' ||
    phase.kind === 'error' ||
    phase.kind === 'creating';

  // --- visual dispatch -----------------------------------------------------

  if (installState === 'installed') {
    return <InstalledPanel pluginId={pluginId} pluginName={pluginName} />;
  }

  if (!enabled) {
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled
          className={cn(
            'group flex w-full items-center justify-between gap-3 rounded-full px-6 py-3.5',
            'bg-[color:var(--bg-soft)] ring-1 ring-inset ring-[color:var(--border)]',
            'cursor-not-allowed text-[color:var(--fg-subtle)]',
          )}
          aria-describedby={`install-${pluginId}-reason`}
        >
          <span className="flex items-center gap-3">
            <Lock className="size-4" aria-hidden />
            <span className="text-[15px] font-semibold">
              Installation blockiert
            </span>
          </span>
        </button>
        {blockingReasons?.length ? (
          <ul
            id={`install-${pluginId}-reason`}
            className="space-y-1 text-[12px] leading-relaxed text-[color:var(--warning)]"
          >
            {blockingReasons.map((reason, idx) => (
              <li key={idx} className="flex gap-2">
                <span className="font-mono-num shrink-0 text-[color:var(--warning)]/70">
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  // --- install available → button + drawer --------------------------------

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label={`${pluginName} installieren`}
        className={cn(
          'group flex w-full items-center justify-between gap-3 rounded-full px-6 py-3.5',
          'bg-[color:var(--accent)] text-[color:var(--accent-fg)] shadow-[var(--shadow-cta)]',
          'transition-[background,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          'hover:bg-[color:var(--accent-hover)] active:translate-y-px active:bg-[color:var(--accent-press)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]',
          'disabled:cursor-not-allowed disabled:opacity-70',
        )}
        disabled={phase.kind === 'creating' || phase.kind === 'success'}
      >
        <span className="text-[15px] font-semibold">
          {phase.kind === 'success' ? 'Installation erfolgreich' : 'Jetzt installieren'}
        </span>
        {phase.kind === 'creating' ? (
          <Loader2 className="size-5 animate-spin" aria-hidden />
        ) : (
          <ArrowRight
            className="size-5 transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        )}
      </button>

      {drawerOpen ? (
        <InstallDrawer
          phase={phase}
          pluginName={pluginName}
          fieldErrors={fieldErrors}
          onClose={handleClose}
          onSubmit={handleSubmit}
        />
      ) : null}

      {phase.kind === 'wizard' ? (
        <RequiresWizard
          targetPluginId={pluginId}
          targetPluginName={pluginName}
          resolution={phase.resolution}
          onClose={handleClose}
        />
      ) : null}
    </>
  );

  async function handleOpen(): Promise<void> {
    setPhase({ kind: 'creating' });
    setFieldErrors({});
    try {
      const resp = await createInstallJob(pluginId);
      setPhase({ kind: 'form', job: resp.job });
    } catch (err) {
      // S+8.5 — install-time capability gate (409 install.missing_capability):
      //   server already computed the full transitive chain. Open the
      //   wizard with the verbatim payload, no client-side recursion.
      if (err instanceof ApiError && err.status === 409) {
        const parsed = tryParseErrorBody(err.body);
        if (parsed?.code === 'install.missing_capability' && parsed.details) {
          const resolution = parsed.details as InstallChainResolution;
          if (
            Array.isArray(resolution.unresolved_requires) &&
            Array.isArray(resolution.available_providers)
          ) {
            setPhase({ kind: 'wizard', resolution });
            return;
          }
        }
      }
      const message =
        err instanceof ApiError
          ? safeMessage(err.body) ?? err.message
          : err instanceof Error
            ? err.message
            : 'Unbekannter Fehler.';
      setPhase({ kind: 'error', job: null, message });
    }
  }

  function handleClose(): void {
    setPhase({ kind: 'idle' });
    setFieldErrors({});
  }

  async function handleSubmit(
    values: Record<string, unknown>,
  ): Promise<void> {
    if (phase.kind !== 'form' && phase.kind !== 'error') return;
    const job = phase.kind === 'form' ? phase.job : phase.job;
    if (!job) return;
    setPhase({ kind: 'submitting', job, values });
    setFieldErrors({});
    try {
      const resp = await configureInstallJob(job.id, values);
      if (resp.job.state === 'active') {
        setPhase({ kind: 'success' });
        // Give the user a moment to see the confirmation, then close + refresh.
        window.setTimeout(() => {
          setPhase({ kind: 'idle' });
          router.refresh();
        }, 900);
      } else if (resp.job.state === 'failed' && resp.job.error) {
        applyServerErrors(resp.job.error);
        setPhase({ kind: 'form', job: resp.job });
      } else {
        setPhase({
          kind: 'error',
          job: resp.job,
          message: `Unerwarteter Job-Zustand: ${resp.job.state}`,
        });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const parsed = tryParseErrorBody(err.body);
        if (parsed?.details) {
          applyDetails(parsed.details);
          setPhase({ kind: 'form', job });
          return;
        }
        setPhase({
          kind: 'error',
          job,
          message: parsed?.message ?? err.message,
        });
        return;
      }
      setPhase({
        kind: 'error',
        job,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function applyServerErrors(error: {
    code: string;
    message: string;
    details?: unknown;
  }): void {
    applyDetails(error.details);
  }

  function applyDetails(details: unknown): void {
    if (!Array.isArray(details)) return;
    const next: Record<string, string> = {};
    for (const entry of details as InstallValidationError[]) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.key === 'string' &&
        typeof entry.message === 'string'
      ) {
        next[entry.key] = entry.message;
      }
    }
    setFieldErrors(next);
  }
}

// ---------------------------------------------------------------------------
// InstalledPanel — shown when a plugin is already installed. Exposes an
// uninstall flow with a confirm dialog. Calls DELETE /install/installed/:id;
// the server triggers the onUninstall hook and hot-unbinds the agent from the
// orchestrator (no restart needed).
// ---------------------------------------------------------------------------

function InstalledPanel({
  pluginId,
  pluginName,
}: {
  pluginId: string;
  pluginName: string;
}): React.ReactElement {
  const router = useRouter();
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'confirming' }
    | { kind: 'working' }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [alsoDeletePackage, setAlsoDeletePackage] = useState(false);

  const working = state.kind === 'working';

  async function doUninstall(): Promise<void> {
    setState({ kind: 'working' });
    try {
      await uninstallPlugin(pluginId);
      let packageDeleted = false;
      if (alsoDeletePackage) {
        try {
          await deleteUploadedPackage(pluginId);
          packageDeleted = true;
        } catch (err) {
          // 404 = not known as an uploaded package (built-in / already gone).
          // Anything else is a real error, but does not revert the uninstall
          // — show as a warning and refresh anyway.
          if (!(err instanceof ApiError) || err.status !== 404) {
            console.warn('package delete failed after uninstall', err);
          }
        }
      }
      // When the uploaded package has been deleted, the detail page
      // (/store/[id]) no longer exists — `router.refresh()` would 404.
      // Instead, navigate back to the store overview.
      if (packageDeleted) {
        router.push('/store');
      } else {
        router.refresh();
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? safeMessage(err.body) ?? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setState({ kind: 'error', message });
    }
  }

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'flex w-full items-center gap-3 rounded-full px-6 py-3.5',
          'bg-[color:var(--success)]/10 ring-1 ring-inset ring-[color:var(--success)]/40',
          'text-[color:var(--success)]',
        )}
      >
        <Check className="size-5" aria-hidden />
        <span className="text-[15px] font-semibold">Installiert</span>
        <span className="ml-auto text-[11px] uppercase tracking-[0.16em] text-[color:var(--success)]/80">
          aktiv
        </span>
      </div>

      {state.kind === 'idle' && (
        <button
          type="button"
          onClick={() => setState({ kind: 'confirming' })}
          className={cn(
            'inline-flex items-center gap-2 text-[12px] font-semibold',
            'text-[color:var(--fg-muted)] transition hover:text-[color:var(--danger,#b03030)]',
          )}
          aria-label={`${pluginName} deinstallieren`}
        >
          <Trash2 className="size-3.5" aria-hidden />
          Deinstallieren
        </button>
      )}

      {state.kind === 'confirming' && (
        <div className="rounded-[10px] border border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-3">
          <p className="text-[12px] leading-relaxed text-[color:var(--fg)]">
            <strong>{pluginName}</strong> entfernen? Tool wird sofort aus dem
            Orchestrator abgebaut, der Vault-Namespace wird geleert, Registry-
            Eintrag gelöscht.
          </p>
          <label className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-[color:var(--fg)]">
            <input
              type="checkbox"
              checked={alsoDeletePackage}
              onChange={(e) => setAlsoDeletePackage(e.target.checked)}
              className="mt-0.5 size-3.5 accent-[color:var(--danger,#b03030)]"
            />
            <span>
              Auch die hochgeladene Paketdatei unter{' '}
              <span className="font-mono-num text-[color:var(--fg-muted)]">
                .uploaded-packages/
              </span>{' '}
              entfernen. <span className="text-[color:var(--fg-subtle)]">
                Ohne Haken bleibt das Package im Katalog und ist neu
                installierbar — nur Built-ins sind davon unberührt.
              </span>
            </span>
          </label>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={doUninstall}
              className="rounded-full bg-[color:var(--danger,#b03030)] px-4 py-1.5 text-[12px] font-semibold text-white"
            >
              {alsoDeletePackage
                ? 'Ja, deinstallieren + löschen'
                : 'Ja, deinstallieren'}
            </button>
            <button
              type="button"
              onClick={() => setState({ kind: 'idle' })}
              className="rounded-full bg-[color:var(--bg)] px-4 py-1.5 text-[12px] font-semibold text-[color:var(--fg-muted)] ring-1 ring-inset ring-[color:var(--border)]"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {working && (
        <div className="inline-flex items-center gap-2 text-[12px] text-[color:var(--fg-muted)]">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Wird deinstalliert …
        </div>
      )}

      {state.kind === 'error' && (
        <div className="rounded-[10px] border border-[color:var(--danger,#b03030)]/40 bg-[color:var(--danger,#b03030)]/6 px-3 py-2">
          <p className="text-[12px] text-[color:var(--danger,#b03030)]">
            Deinstallation fehlgeschlagen: {state.message}
          </p>
          <button
            type="button"
            onClick={() => setState({ kind: 'idle' })}
            className="mt-1 text-[11px] text-[color:var(--fg-subtle)] hover:text-[color:var(--fg)]"
          >
            Zurücksetzen
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InstallDrawer — slide-over panel with rendered setup form
// ---------------------------------------------------------------------------

interface InstallDrawerProps {
  phase: Phase;
  pluginName: string;
  fieldErrors: Record<string, string>;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
}

function InstallDrawer({
  phase,
  pluginName,
  fieldErrors,
  onClose,
  onSubmit,
}: InstallDrawerProps): React.ReactElement {
  const jobFromPhase =
    phase.kind === 'form'
      ? phase.job
      : phase.kind === 'submitting'
        ? phase.job
        : phase.kind === 'error'
          ? phase.job
          : null;

  const fields = jobFromPhase?.setup_schema?.fields ?? [];
  const submitting = phase.kind === 'submitting';

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={`${pluginName} einrichten`}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Abbrechen"
        className="absolute inset-0 bg-[color:var(--ink)]/40 backdrop-blur-sm transition"
      />

      <aside
        className={cn(
          'relative z-10 flex w-full max-w-xl flex-col',
          'border-l border-[color:var(--rule-strong)] bg-[color:var(--paper)]',
          'shadow-[-20px_0_60px_-20px_rgba(0,0,0,0.3)]',
        )}
      >
        <header className="flex items-start justify-between gap-6 border-b border-[color:var(--rule)] px-8 py-6">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-[color:var(--faint-ink)]">
              Einrichtung
            </div>
            <h2 className="font-display mt-2 text-3xl font-medium leading-tight text-[color:var(--ink)]">
              {pluginName}
            </h2>
            {jobFromPhase ? (
              <p className="font-mono-num mt-2 text-[11px] text-[color:var(--faint-ink)]">
                Job · {jobFromPhase.id.slice(0, 8)}… ·{' '}
                <span className="text-[color:var(--muted-ink)]">
                  {jobFromPhase.current_step}
                </span>
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--muted-ink)] transition hover:text-[color:var(--ink)]"
          >
            Schließen
          </button>
        </header>

        {phase.kind === 'creating' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-[color:var(--muted-ink)]">
            <Loader2 className="size-8 animate-spin" aria-hidden />
            <span className="text-sm">Job wird erstellt …</span>
          </div>
        ) : phase.kind === 'error' && !jobFromPhase ? (
          <div className="flex-1 p-10">
            <InstallErrorBlock message={phase.message} />
          </div>
        ) : (
          <form
            className="flex flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              if (submitting) return;
              const formData = new FormData(e.currentTarget);
              const values = extractValues(fields, formData);
              void onSubmit(values);
            }}
          >
            <div className="flex-1 overflow-y-auto px-8 py-6">
              {fields.length === 0 ? (
                <p className="text-sm italic text-[color:var(--muted-ink)]">
                  Dieses Plugin erfordert keine Konfiguration — bestätige die
                  Installation rechts unten.
                </p>
              ) : (
                <div className="space-y-5">
                  {fields.map((field) => (
                    <FieldRow
                      key={field.key}
                      field={field}
                      error={fieldErrors[field.key]}
                    />
                  ))}
                </div>
              )}

              {phase.kind === 'error' && jobFromPhase ? (
                <div className="mt-6">
                  <InstallErrorBlock message={phase.message} />
                </div>
              ) : null}
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-[color:var(--rule)] bg-[color:var(--paper-soft)] px-8 py-5">
              <p className="text-[11px] leading-relaxed text-[color:var(--muted-ink)]">
                Secrets werden ausschließlich im per-Agent-Vault abgelegt.
                <br />
                Andere Werte landen in der Instanz-Konfiguration.
              </p>
              <button
                type="submit"
                disabled={submitting}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full px-6 py-3',
                  'bg-[color:var(--accent)] text-[color:var(--accent-fg)] shadow-[var(--shadow-cta)]',
                  'transition-[background,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                  'hover:bg-[color:var(--accent-hover)] active:translate-y-px',
                  'disabled:cursor-wait disabled:opacity-70',
                )}
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                <span className="text-[15px] font-semibold">
                  {submitting ? 'Wird installiert …' : 'Installation bestätigen'}
                </span>
              </button>
            </footer>
          </form>
        )}
      </aside>
    </div>
  );
}

function InstallErrorBlock({
  message,
}: {
  message: string;
}): React.ReactElement {
  return (
    <div className="border border-[color:var(--oxblood)] bg-[color:var(--oxblood)]/5 p-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[color:var(--oxblood)]">
        Fehler
      </div>
      <p className="font-mono-num mt-2 text-sm text-[color:var(--oxblood-ink)]">
        {message}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseErrorBody(body: string): {
  code?: string;
  message?: string;
  details?: unknown;
} | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as {
      code?: string;
      message?: string;
      details?: unknown;
    };
  } catch {
    return null;
  }
}

function safeMessage(body: string): string | null {
  const parsed = tryParseErrorBody(body);
  return parsed?.message ?? null;
}
