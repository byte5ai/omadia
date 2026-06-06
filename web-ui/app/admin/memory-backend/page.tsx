'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import {
  ApiError,
  getMemoryBackend,
  setMemoryBackend,
  previewMemoryMigration,
  runMemoryMigration,
  type MemoryBackend,
  type MemoryBackendState,
  type MemoryMigrationPreview,
  type MemoryMigrationResult,
} from '../../_lib/api';

/**
 * Admin → Memory · Speicher-Backend.
 *
 * Read/write the persisted memory-storage backend choice (filesystem ↔
 * postgres). The backend is selected at boot by the middleware's
 * `bootstrapMemoryFromEnv`; a persisted operator choice wins over the
 * `MEMORY_BACKEND` env default. Postgres REQUIRES `DATABASE_URL` (it consumes
 * the Neon KG's shared graphPool).
 *
 * This page only PERSISTS the choice. The provider swap happens on the NEXT
 * restart — so on a successful save the operator is told a restart is
 * required. Backed by `/bot-api/v1/admin/memory/backend` (cookie-session auth,
 * same admin router family as the Danger Zone purge page).
 */

const BACKENDS: ReadonlyArray<{ value: MemoryBackend; label: string }> = [
  { value: 'filesystem', label: 'Dateisystem (filesystem)' },
  { value: 'postgres', label: 'Postgres (postgres)' },
];

/** Surface the inline 400 `database_url_required` payload from an ApiError. */
function databaseUrlRequiredFromError(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 400) return false;
  try {
    const parsed = JSON.parse(err.body) as { error?: string };
    return parsed.error === 'database_url_required';
  } catch {
    return false;
  }
}

export default function MemoryBackendPage(): React.ReactElement {
  const [state, setState] = useState<MemoryBackendState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [choice, setChoice] = useState<MemoryBackend>('filesystem');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<MemoryBackend | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await getMemoryBackend();
      setState(s);
      setChoice(s.current);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: load()'s synchronous setState (setLoading(true) /
    // setLoadError(null)) are same-value no-ops on mount — `loading` already
    // starts true; the data lands after the awaited fetch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const dbMissing = state !== null && !state.databaseUrlPresent;
  // Block submitting postgres when DATABASE_URL is absent — the backend would
  // 400 anyway, but disabling the action makes the constraint explicit.
  const canSave =
    state !== null &&
    !saving &&
    choice !== state.current &&
    !(choice === 'postgres' && dbMissing);

  const onSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const r = await setMemoryBackend(choice);
      setSaved(r.backend);
      // Re-read so `restartRequiredToApply` / `current` reflect the new choice.
      await load();
    } catch (err) {
      if (databaseUrlRequiredFromError(err)) {
        setSaveError(
          'Postgres benötigt DATABASE_URL (Neon-KG/graphPool). Setze DATABASE_URL und starte neu, bevor du auf Postgres wechselst.',
        );
      } else if (err instanceof ApiError && err.status === 403) {
        setSaveError(
          'Nicht berechtigt (403) — das Umschalten des Backends erfordert Admin-Rechte.',
        );
      } else if (err instanceof ApiError && err.status === 409) {
        setSaveError(
          'Kein Memory-Provider registriert (409) — die Auswahl kann nicht gespeichert werden.',
        );
      } else {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }, [choice, load]);

  // --- One-time memory migration (on-disk /memories → active backend) -------
  const [migPreview, setMigPreview] = useState<MemoryMigrationPreview | null>(
    null,
  );
  const [migResult, setMigResult] = useState<MemoryMigrationResult | null>(null);
  const [migBusy, setMigBusy] = useState(false);
  const [migError, setMigError] = useState<string | null>(null);

  const onPreviewMigration = useCallback(async (): Promise<void> => {
    setMigBusy(true);
    setMigError(null);
    setMigResult(null);
    try {
      setMigPreview(await previewMemoryMigration());
    } catch (err) {
      setMigError(err instanceof Error ? err.message : String(err));
      setMigPreview(null);
    } finally {
      setMigBusy(false);
    }
  }, []);

  const onRunMigration = useCallback(async (): Promise<void> => {
    setMigBusy(true);
    setMigError(null);
    try {
      const r = await runMemoryMigration();
      setMigResult(r);
      // Refresh the preview so a follow-up shows everything now present.
      setMigPreview(await previewMemoryMigration());
    } catch (err) {
      setMigError(err instanceof Error ? err.message : String(err));
    } finally {
      setMigBusy(false);
    }
  }, []);

  return (
    <main className="mx-auto max-w-[800px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Memory · Speicher-Backend
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          Schaltet das Memory-Storage zwischen <strong>Dateisystem</strong> und{' '}
          <strong>Postgres</strong> um. Postgres benötigt{' '}
          <code className="font-mono">DATABASE_URL</code> (Neon-KG/graphPool).
          Die Auswahl wird gespeichert, der Wechsel greift erst nach einem
          Neustart.
        </p>
      </header>

      {loading && (
        <section className="mb-6 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5 text-sm text-[color:var(--fg-muted)]">
          lädt…
        </section>
      )}

      {loadError !== null && (
        <section className="mb-6 rounded-[14px] border border-red-400 bg-red-50 p-5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          Laden fehlgeschlagen: {loadError}
        </section>
      )}

      {state !== null && !loading && (
        <>
          <section className="mb-6 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
            <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              Aktueller Stand
            </h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-neutral-500">Aktives Backend</dt>
              <dd className="font-mono">{state.current}</dd>
              <dt className="text-neutral-500">Env-Default</dt>
              <dd className="font-mono">{state.envDefault}</dd>
              <dt className="text-neutral-500">Aktiver Provider</dt>
              <dd className="font-mono">{state.activeProviderId ?? '—'}</dd>
              <dt className="text-neutral-500">DATABASE_URL</dt>
              <dd className="font-mono">
                {state.databaseUrlPresent ? 'gesetzt' : 'nicht gesetzt'}
              </dd>
            </dl>
          </section>

          {state.restartRequiredToApply && (
            <section className="mb-6 rounded-[14px] border border-amber-500/50 bg-amber-500/10 p-4 text-sm font-medium text-amber-700 dark:text-amber-300">
              ⚠ Ein Wechsel ist gespeichert, aber noch nicht aktiv — Neustart
              erforderlich, damit der Wechsel greift.
            </section>
          )}

          <section className="mb-6 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
            <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              Backend wählen
            </h2>
            <div className="flex flex-col gap-2">
              {BACKENDS.map((b) => {
                const disabled = b.value === 'postgres' && dbMissing;
                return (
                  <label
                    key={b.value}
                    className={
                      disabled
                        ? 'flex items-center gap-2 text-sm text-neutral-400 dark:text-neutral-600'
                        : 'flex items-center gap-2 text-sm text-[color:var(--fg-strong)]'
                    }
                  >
                    <input
                      type="radio"
                      name="memory-backend"
                      value={b.value}
                      checked={choice === b.value}
                      disabled={disabled || saving}
                      onChange={() => {
                        setChoice(b.value);
                        setSaved(null);
                        setSaveError(null);
                      }}
                    />
                    <span>{b.label}</span>
                    {disabled && (
                      <span className="text-xs text-neutral-500">
                        — benötigt DATABASE_URL (Neon-KG/graphPool)
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            <div className="mt-4 flex items-center justify-end">
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={!canSave}
                className="rounded bg-[color:var(--accent)] px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? 'speichert…' : 'Auswahl speichern'}
              </button>
            </div>
          </section>

          {saveError !== null && (
            <section className="mb-6 rounded-[14px] border border-red-400 bg-red-50 p-5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              {saveError}
            </section>
          )}

          {saved !== null && saveError === null && (
            <section className="rounded-[14px] border border-amber-500/50 bg-amber-500/10 p-5 text-sm text-amber-700 dark:text-amber-300">
              <p className="font-semibold">
                Backend <code className="font-mono">{saved}</code> gespeichert.
              </p>
              <p className="mt-1">
                Neustart erforderlich, damit der Wechsel greift.
              </p>
            </section>
          )}

          <section className="mt-8 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5">
            <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              Bestehende Dateien migrieren
            </h2>
            <p className="mb-4 text-sm leading-[1.55] text-[color:var(--fg-muted)]">
              Kopiert alle vorhandenen <code className="font-mono">/memories</code>
              -Dateien vom Dateisystem (<code className="font-mono">MEMORY_DIR</code>)
              in das aktuell aktive Speicher-Backend. <strong>Nach dem Umschalten
              auf Postgres einmalig ausführen, solange die alte Datei-Volume noch
              gemountet ist</strong> — sonst bleiben die bisherigen Memory-Daten
              verwaist. Solange das aktive Backend noch das Dateisystem ist, sind
              alle Pfade bereits vorhanden und werden übersprungen (No-op).
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void onPreviewMigration()}
                disabled={migBusy}
                className="rounded border border-[color:var(--border)] px-4 py-1.5 text-xs font-semibold text-[color:var(--fg-strong)] hover:bg-[color:var(--card)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {migBusy ? 'lädt…' : 'Vorschau'}
              </button>
              <button
                type="button"
                onClick={() => void onRunMigration()}
                disabled={migBusy}
                className="rounded bg-[color:var(--accent)] px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {migBusy ? 'läuft…' : 'Migrieren'}
              </button>
            </div>

            {migError !== null && (
              <div className="mt-4 rounded-[12px] border border-red-400 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
                Migration fehlgeschlagen: {migError}
              </div>
            )}

            {migPreview !== null && migResult === null && migError === null && (
              <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-neutral-500">Dateien gesamt</dt>
                <dd className="font-mono">{migPreview.totalFiles}</dd>
                <dt className="text-neutral-500">Würde kopieren</dt>
                <dd className="font-mono">{migPreview.wouldCopy}</dd>
                <dt className="text-neutral-500">Bereits vorhanden</dt>
                <dd className="font-mono">{migPreview.alreadyPresent}</dd>
              </dl>
            )}

            {migResult !== null && migError === null && (
              <div className="mt-4 rounded-[12px] border border-emerald-500/50 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">
                <p className="font-semibold">Migration abgeschlossen.</p>
                <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                  <dt className="opacity-80">Kopiert</dt>
                  <dd className="font-mono">{migResult.copied}</dd>
                  <dt className="opacity-80">Übersprungen</dt>
                  <dd className="font-mono">{migResult.skipped}</dd>
                  <dt className="opacity-80">Fehlgeschlagen</dt>
                  <dd className="font-mono">{migResult.failed}</dd>
                </dl>
                {migResult.failed > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs">
                    {migResult.errors.slice(0, 10).map((e) => (
                      <li key={e.path}>
                        <code className="font-mono">{e.path}</code>: {e.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
