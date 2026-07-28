'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  AdminAuthProvider,
  ApiError,
  disableAdminAuthProvider,
  enableAdminAuthProvider,
  getAdminAuthProviders,
} from '../../_lib/api';

type TFn = (key: string, values?: Record<string, string | number>) => string;

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; providers: AdminAuthProvider[] }
  | { kind: 'error'; message: string };

/**
 * Admin UI for toggling auth providers (OB-50).
 *
 * Backend contract (D1=C "Hybrid"):
 *   - `configured` = contained in the AUTH_PROVIDERS env var (static)
 *   - `active`     = currently registered (toggle state)
 *   - Providers not in the whitelist are never returned in the GET response
 *     → no UI path to enable them.
 *
 * Server validation handles edge cases (last-active, self-lockout):
 *   we surface the server codes through instead of duplicating them client-side.
 */
export default function AdminAuthPage(): React.ReactElement {
  const t = useTranslations('adminAuth');
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
    // Fetch-on-mount: reload() touches state only after the awaited
    // network round-trip — no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      setActionError(toFriendlyError(err, p.active, t));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t.rich('intro', {
            envVar: () => (
              <code className="rounded bg-[color:var(--card)] px-1 py-0.5 text-[12px]">
                AUTH_PROVIDERS
              </code>
            ),
          })}
        </p>
      </header>

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-[color:var(--danger)]">
          {t('loadError', { message: state.message })}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.providers.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
            >
              <div className="flex flex-1 flex-col">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-[color:var(--fg-strong)]">
                    {p.display_name}
                  </span>
                  <code className="rounded bg-[color:var(--card)] px-2 py-0.5 text-[11px] text-[color:var(--fg-muted)]">
                    {p.id}
                  </code>
                  <code className="rounded bg-[color:var(--card)] px-2 py-0.5 text-[11px] text-[color:var(--fg-muted)]">
                    {p.kind}
                  </code>
                </div>
                <span
                  className={[
                    'mt-1 inline-flex w-fit items-center gap-2 rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em]',
                    p.active
                      ? 'bg-[color:var(--success)]/10 text-[color:var(--success)]'
                      : 'bg-[color:var(--border)]/40 text-[color:var(--fg-muted)]',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'h-1.5 w-1.5 rounded-full',
                      p.active ? 'bg-[color:var(--success)]/100' : 'bg-[color:var(--fg-muted)]',
                    ].join(' ')}
                  />
                  {p.active ? t('statusActive') : t('statusInactive')}
                </span>
              </div>
              <Button
                variant={p.active ? 'secondary' : 'primary'}
                onClick={() => void toggle(p)}
                busy={pendingId === p.id}
                busyLabel={p.active ? t('disable') : t('enable')}
              >
                {p.active ? t('disable') : t('enable')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {actionError && (
        <p className="mt-4 text-sm text-[color:var(--danger)]">{actionError}</p>
      )}
    </main>
  );
}

function toFriendlyError(err: unknown, wasActive: boolean, t: TFn): string {
  if (err instanceof ApiError) {
    if (err.body.includes('self_lockout')) {
      return t('errors.selfLockout');
    }
    if (err.body.includes('last_active_provider')) {
      return t('errors.lastActiveProvider');
    }
    if (err.body.includes('not_in_whitelist')) {
      return t('errors.notInWhitelist');
    }
    return wasActive
      ? t('errors.disableFailed', { status: err.status })
      : t('errors.enableFailed', { status: err.status });
  }
  return err instanceof Error ? err.message : String(err);
}
