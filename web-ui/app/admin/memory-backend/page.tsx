'use client';

import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
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
 * Read/write the persisted memory-storage backend choice (postgres ↔
 * inmemory). The backend is selected at boot by the middleware's
 * `bootstrapMemoryFromEnv`; a persisted operator choice wins over the
 * `MEMORY_BACKEND` env value, which wins over the derived default
 * (`DATABASE_URL ? postgres : inmemory`). Postgres REQUIRES `DATABASE_URL`
 * (it consumes the Neon KG's shared graphPool).
 *
 * This page only PERSISTS the choice. The provider swap happens on the NEXT
 * restart — so on a successful save the operator is told a restart is
 * required. Backed by `/bot-api/v1/admin/memory/backend` (cookie-session auth,
 * same admin router family as the Danger Zone purge page).
 */

// Stable backend keys — labels are translated at render via
// `adminMemoryBackend.backends.*`.
const BACKENDS: ReadonlyArray<MemoryBackend> = ['postgres', 'inmemory'];

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
  const t = useTranslations('adminMemoryBackend');
  const [state, setState] = useState<MemoryBackendState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [choice, setChoice] = useState<MemoryBackend>('inmemory');
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
        setSaveError(t('dbUrlRequiredError'));
      } else if (err instanceof ApiError && err.status === 403) {
        setSaveError(t('forbiddenError'));
      } else if (err instanceof ApiError && err.status === 409) {
        setSaveError(t('noProviderError'));
      } else {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }, [choice, load, t]);

  return (
    <main className="mx-auto max-w-[800px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t.rich('intro', {
            strong: (chunks) => <strong>{chunks}</strong>,
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </header>

      {loading && (
        <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 text-sm text-[color:var(--fg-muted)]">
          {t('loading')}
        </section>
      )}

      {loadError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {t('loadFailed', { message: loadError })}
        </section>
      )}

      {state !== null && !loading && (
        <>
          <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
            <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('currentStateTitle')}
            </h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-[color:var(--fg-muted)]">
                {t('activeBackend')}
              </dt>
              <dd className="font-mono">{state.current}</dd>
              <dt className="text-[color:var(--fg-muted)]">{t('envDefault')}</dt>
              <dd className="font-mono">{state.envDefault}</dd>
              <dt className="text-[color:var(--fg-muted)]">
                {t('activeProvider')}
              </dt>
              <dd className="font-mono">{state.activeProviderId ?? '—'}</dd>
              <dt className="text-[color:var(--fg-muted)]">DATABASE_URL</dt>
              <dd className="font-mono">
                {state.databaseUrlPresent ? t('dbUrlSet') : t('dbUrlNotSet')}
              </dd>
            </dl>
          </section>

          {state.restartRequiredToApply && (
            <section className="mb-6 rounded-lg border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 p-4 text-sm font-medium text-[color:var(--warning)]">
              {t('restartPending')}
            </section>
          )}

          <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
            <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('chooseBackendTitle')}
            </h2>
            <div className="flex flex-col gap-2">
              {BACKENDS.map((b) => {
                const disabled = b === 'postgres' && dbMissing;
                return (
                  <label
                    key={b}
                    className={
                      disabled
                        ? 'flex items-center gap-2 text-sm text-[color:var(--fg-subtle)]'
                        : 'flex items-center gap-2 text-sm text-[color:var(--fg-strong)]'
                    }
                  >
                    <input
                      type="radio"
                      name="memory-backend"
                      value={b}
                      checked={choice === b}
                      disabled={disabled || saving}
                      onChange={() => {
                        setChoice(b);
                        setSaved(null);
                        setSaveError(null);
                      }}
                    />
                    <span>{t(`backends.${b}`)}</span>
                    {disabled && (
                      <span className="text-xs text-[color:var(--fg-muted)]">
                        {t('requiresDbUrl')}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            <div className="mt-4 flex items-center justify-end">
              <Button
                variant="primary"
                onClick={() => void onSave()}
                disabled={!canSave}
              >
                {saving ? t('saving') : t('saveButton')}
              </Button>
            </div>
          </section>

          {saveError !== null && (
            <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
              {saveError}
            </section>
          )}

          {saved !== null && saveError === null && (
            <section className="rounded-lg border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 p-4 text-sm text-[color:var(--warning)]">
              <p className="font-semibold">
                {t.rich('savedMessage', {
                  backend: saved,
                  code: (chunks) => (
                    <code className="font-mono">{chunks}</code>
                  ),
                })}
              </p>
              <p className="mt-1">{t('restartRequired')}</p>
            </section>
          )}

        </>
      )}
    </main>
  );
}
