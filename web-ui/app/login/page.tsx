'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  ApiError,
  getAuthProviders,
  postAuthLogin,
  type AuthProviderSummary,
} from '../_lib/api';

type State =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      providers: AuthProviderSummary[];
      activePasswordProviderId: string | null;
    }
  | { kind: 'no-providers' }
  | { kind: 'error'; message: string };

/**
 * Provider-aware login page (OB-49).
 *
 * Flow:
 *   1. On mount, hit /api/v1/auth/providers. If `setup_required` → redirect
 *      to /setup wizard.
 *   2. Render the active providers. Password-providers get an inline form;
 *      OIDC-providers get a button that does a server-rendered redirect to
 *      /api/v1/auth/login/<id>/start (which 302s to the IdP).
 *   3. On successful password login, redirect to `?return=` (sanitised by
 *      the server side via cookie-based session) or '/'.
 */
export default function LoginPage(): React.ReactElement {
  // Next 15 SSG bails when `useSearchParams()` is reached without a
  // surrounding Suspense boundary. Wrap the body so the build can render
  // a stable shell and hydrate the client-side query parsing post-mount.
  return (
    <Suspense fallback={<LoginPageShell />}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageShell(): React.ReactElement {
  const t = useTranslations('login');
  return (
    <main className="mx-auto max-w-[480px] px-6 py-16 text-center text-[color:var(--fg-muted)]">
      {t('shellLoading')}
    </main>
  );
}

function LoginPageInner(): React.ReactElement {
  const t = useTranslations('login');
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnPath = useMemo(() => {
    const raw = searchParams.get('return');
    if (typeof raw !== 'string') return '/';
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
    return raw;
  }, [searchParams]);

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAuthProviders();
        if (cancelled) return;
        if (res.setup_required) {
          router.replace(
            `/setup?return=${encodeURIComponent(returnPath)}`,
          );
          return;
        }
        if (res.providers.length === 0) {
          setState({ kind: 'no-providers' });
          return;
        }
        const password = res.providers.find((p) => p.kind === 'password');
        setState({
          kind: 'ready',
          providers: res.providers,
          activePasswordProviderId: password?.id ?? null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [returnPath, router]);

  async function handlePasswordSubmit(
    e: React.FormEvent<HTMLFormElement>,
    providerId: string,
  ): Promise<void> {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await postAuthLogin(providerId, { email, password });
      // Cookie set by the server; bounce to the originally-requested path.
      window.location.href = returnPath;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSubmitError(t('incorrectCredentials'));
      } else {
        setSubmitError(
          err instanceof Error ? err.message : String(err),
        );
      }
      setSubmitting(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <PageShell>
        <p className="text-sm opacity-70">{t('loadingProviders')}</p>
      </PageShell>
    );
  }

  if (state.kind === 'error') {
    return (
      <PageShell>
        <p className="text-sm text-red-500">
          {t('errorPrefix')} {state.message}
        </p>
      </PageShell>
    );
  }

  if (state.kind === 'no-providers') {
    return (
      <PageShell>
        <p className="text-sm text-amber-500">
          {t.rich('noProviders', {
            envVar: () => <code>AUTH_PROVIDERS</code>,
          })}
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      {state.activePasswordProviderId && (
        <form
          onSubmit={(e) =>
            handlePasswordSubmit(e, state.activePasswordProviderId as string)
          }
          className="flex flex-col gap-3"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('emailLabel')}</span>
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t('passwordLabel')}</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </label>
          {submitError && (
            <p className="text-sm text-red-500">{submitError}</p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
          >
            {submitting ? t('submitting') : t('submit')}
          </button>
        </form>
      )}

      {state.providers.some((p) => p.kind === 'oidc') && (
        <>
          {state.activePasswordProviderId && (
            <div className="my-4 flex items-center gap-3 text-xs opacity-50">
              <span className="h-px flex-1 bg-[color:var(--border)]" />
              <span>{t('or')}</span>
              <span className="h-px flex-1 bg-[color:var(--border)]" />
            </div>
          )}
          <div className="flex flex-col gap-2">
            {state.providers
              .filter((p) => p.kind === 'oidc')
              .map((p) => (
                <a
                  key={p.id}
                  href={`/bot-api/v1/auth/login/${encodeURIComponent(
                    p.id,
                  )}/start?return=${encodeURIComponent(returnPath)}`}
                  className="rounded-md border border-[color:var(--border)] px-4 py-2 text-center text-sm font-medium hover:bg-[color:var(--border)]/30"
                >
                  {t('continueWith', { provider: p.displayName })}
                </a>
              ))}
          </div>
        </>
      )}
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-6 shadow-sm">
        <header className="mb-6 flex flex-col leading-none">
          <h1 className="font-display text-3xl text-[color:var(--fg-strong)]">
            Omadia
          </h1>
          <span className="mt-1.5 text-[11px] uppercase tracking-[0.18em] text-[color:var(--fg-muted)]">
            an Agentic OS
          </span>
        </header>
        {children}
      </div>
    </main>
  );
}
