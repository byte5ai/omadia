'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import {
  ApiError,
  getMemoryBackend,
  setMemoryBackend,
  type MemoryBackend,
  type MemoryBackendState,
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

        </>
      )}
    </main>
  );
}
