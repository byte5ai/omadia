'use client';

import { useEffect, useState } from 'react';

import {
  AdminAuthProvider,
  ApiError,
  disableAdminAuthProvider,
  enableAdminAuthProvider,
  getAdminAuthProviders,
} from '../../_lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; providers: AdminAuthProvider[] }
  | { kind: 'error'; message: string };

/**
 * Admin-UI zum Toggle der Auth-Provider (OB-50).
 *
 * Backend-Vertrag (D1=C "Hybrid"):
 *   - `configured` = im AUTH_PROVIDERS env-var enthalten (statisch)
 *   - `active`     = aktuell registriert (Toggle-State)
 *   - Provider, die nicht in der Whitelist sind, kommen erst gar nicht
 *     im GET zurück → kein UI-Pfad sie einzuschalten.
 *
 * Server-Validierung greift bei Edge-Cases (last-active, self-lockout):
 *   wir surfen die Server-Codes durch, statt sie im Client zu duplizieren.
 */
export default function AdminAuthPage(): React.ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function reload(): Promise<void> {
    try {
      const res = await getAdminAuthProviders();
      setState({ kind: 'ready', providers: res.providers });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function toggle(p: AdminAuthProvider): Promise<void> {
    setActionError(null);
    setPendingId(p.id);
    try {
      if (p.active) {
        await disableAdminAuthProvider(p.id);
      } else {
        await enableAdminAuthProvider(p.id);
      }
      await reload();
    } catch (err) {
      setActionError(toFriendlyError(err, p.active));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-10 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          Authentifizierungs-Provider
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          Aktiviere oder deaktiviere die Anmelde-Verfahren. Die env-Variable{' '}
          <code className="rounded bg-[color:var(--card)] px-1 py-0.5 text-[12px]">
            AUTH_PROVIDERS
          </code>{' '}
          definiert die zulässigen Provider; hier wählst du, welche davon
          aktuell aktiv sind.
        </p>
      </header>

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">Lädt …</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-red-500">
          Fehler beim Laden: {state.message}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.providers.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] border border-[color:var(--border)] bg-[color:var(--card)]/40 p-5"
            >
              <div className="flex flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-[color:var(--fg-strong)]">
                    {p.display_name}
                  </span>
                  <code className="rounded bg-[color:var(--card)] px-1.5 py-0.5 text-[11px] text-[color:var(--fg-muted)]">
                    {p.id}
                  </code>
                  <code className="rounded bg-[color:var(--card)] px-1.5 py-0.5 text-[11px] text-[color:var(--fg-muted)]">
                    {p.kind}
                  </code>
                </div>
                <span
                  className={[
                    'mt-1 inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
                    p.active
                      ? 'bg-emerald-500/10 text-emerald-500'
                      : 'bg-[color:var(--border)]/40 text-[color:var(--fg-muted)]',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'h-1.5 w-1.5 rounded-full',
                      p.active ? 'bg-emerald-500' : 'bg-[color:var(--fg-muted)]',
                    ].join(' ')}
                  />
                  {p.active ? 'aktiv' : 'inaktiv'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void toggle(p)}
                disabled={pendingId === p.id}
                className={[
                  'rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50',
                  p.active
                    ? 'border border-[color:var(--border)] text-[color:var(--fg-strong)] hover:bg-[color:var(--card)]'
                    : 'bg-[color:var(--accent)] text-black',
                ].join(' ')}
              >
                {pendingId === p.id
                  ? '…'
                  : p.active
                  ? 'Deaktivieren'
                  : 'Aktivieren'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {actionError && (
        <p className="mt-4 text-sm text-red-500">{actionError}</p>
      )}
    </main>
  );
}

function toFriendlyError(err: unknown, wasActive: boolean): string {
  if (err instanceof ApiError) {
    if (err.body.includes('self_lockout')) {
      return 'Du kannst nicht den Provider deaktivieren, mit dem du gerade angemeldet bist.';
    }
    if (err.body.includes('last_active_provider')) {
      return 'Mindestens ein Provider muss aktiv bleiben — sonst kommt niemand mehr rein.';
    }
    if (err.body.includes('not_in_whitelist')) {
      return 'Dieser Provider ist nicht in der AUTH_PROVIDERS-Whitelist erlaubt.';
    }
    return `Fehler ${err.status}: ${wasActive ? 'Deaktivieren' : 'Aktivieren'} fehlgeschlagen.`;
  }
  return err instanceof Error ? err.message : String(err);
}
