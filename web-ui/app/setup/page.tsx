'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  ApiError,
  getAuthProviders,
  postAuthSetup,
} from '../_lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'locked' }
  | { kind: 'error'; message: string };

/**
 * First-user-setup wizard (OB-49).
 *
 * Pre-flight: GET /api/v1/auth/providers — if `setup_required` is false,
 * the wizard has already run; redirect to /login. Otherwise render a form
 * that POSTs `{email, password, display_name}` to /api/v1/auth/setup.
 *
 * On success the server mints + sets the session cookie itself, so we
 * just bounce the browser to the originally-requested path.
 */
export default function SetupPage(): React.ReactElement {
  // Same Next-15 SSG bail as /login: useSearchParams() needs a Suspense
  // boundary above it.
  return (
    <Suspense fallback={<SetupPageShell />}>
      <SetupPageInner />
    </Suspense>
  );
}

function SetupPageShell(): React.ReactElement {
  const t = useTranslations('setup');
  return (
    <main className="mx-auto max-w-[480px] px-6 py-16 text-center text-[color:var(--fg-muted)]">
      {t('shellLoading')}
    </main>
  );
}

function SetupPageInner(): React.ReactElement {
  const t = useTranslations('setup');
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
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAuthProviders();
        if (cancelled) return;
        if (!res.setup_required) {
          setState({ kind: 'locked' });
          return;
        }
        setState({ kind: 'ready' });
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
  }, []);

  async function handleSubmit(
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    e.preventDefault();
    setSubmitError(null);
    if (password !== confirm) {
      setSubmitError(t('passwordsMismatch'));
      return;
    }
    if (password.length < 8) {
      setSubmitError(t('passwordTooShort'));
      return;
    }
    setSubmitting(true);
    try {
      await postAuthSetup({
        email,
        password,
        ...(displayName.length > 0 ? { display_name: displayName } : {}),
      });
      window.location.href = returnPath;
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setSubmitError(t('alreadyLocked'));
        setTimeout(() => router.replace('/login'), 1500);
      } else if (err instanceof ApiError && err.status === 400) {
        setSubmitError(t('credentialsRejected'));
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
      setSubmitting(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <PageShell>
        <p className="text-sm opacity-70">{t('loading')}</p>
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
  if (state.kind === 'locked') {
    return (
      <PageShell>
        <p className="text-sm">
          {t('lockedNotice')}{' '}
          <a className="underline" href="/login">
            {t('loginLink')}
          </a>
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <p className="mb-4 text-sm opacity-70">{t('intro')}</p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
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
          <span className="font-medium">{t('displayNameLabel')}</span>
          <input
            type="text"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('passwordLabel')}</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[color:var(--accent)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('confirmPasswordLabel')}</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
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
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const t = useTranslations('setup');
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-6 shadow-sm">
        <h1 className="mb-4 text-lg font-semibold">{t('title')}</h1>
        {children}
      </div>
    </main>
  );
}
