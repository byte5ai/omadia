'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslations } from 'next-intl';

import { ApiError, getAuthMe, postAuthLogout, type AuthUser } from '../_lib/api';

type State =
  | { kind: 'loading' }
  | { kind: 'authed'; user: AuthUser }
  | { kind: 'anon' }
  | { kind: 'error'; message: string };

export function AuthBadge(): React.ReactElement | null {
  const t = useTranslations('authBadge');
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAuthMe();
        if (!cancelled) setState({ kind: 'authed', user: res.user });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ kind: 'anon' });
        } else {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent): void => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  const handleLogout = useCallback(async () => {
    setSigningOut(true);
    try {
      const res = await postAuthLogout();
      // OB-49 — server returns an array of IdP-side logout URLs (one per
      // OIDC provider that issued the session). For local sessions the
      // array is empty; we just land on /login.
      const idpLogout = res.logout_urls.find((entry) => entry.url);
      window.location.href = idpLogout ? idpLogout.url : '/login';
    } catch {
      // Even if the server-side logout throws, clear the local UI state
      // and bounce to /login — the edge middleware will re-kick the flow.
      window.location.href = '/login';
    }
  }, []);

  if (state.kind === 'loading') {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="h-8 w-24 rounded-full bg-[color:var(--border)]/40"
        aria-hidden
      />
    );
  }

  if (state.kind === 'anon') {
    return (
      <a
        href="/login"
        className="inline-flex items-center gap-2 rounded-full border border-[color:var(--border)] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-[color:var(--fg-muted)] transition-colors hover:border-[color:var(--accent)] hover:text-[color:var(--ink)]"
      >
        <span className="text-[color:var(--highlight)] font-[900]">:</span>
        {t('loginLink')}
      </a>
    );
  }

  if (state.kind === 'error') {
    return (
      <span
        className="text-[11px] uppercase tracking-[0.18em] text-rose-600"
        title={state.message}
      >
        {t('authError')}
      </span>
    );
  }

  const { user } = state;
  const initials = getInitials(user.display_name || user.email);
  return (
    <div ref={menuRef} className="relative">
      <motion.button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        whileTap={{ scale: 0.97 }}
        className="inline-flex items-center gap-2 rounded-full border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1 pl-1 text-left transition-colors hover:border-[color:var(--accent)]"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--accent)]/15 font-mono text-[10px] font-semibold uppercase text-[color:var(--accent)]">
          {initials}
        </span>
        <span className="hidden text-xs text-[color:var(--fg-strong)] sm:inline">
          {firstName(user.display_name) || user.email}
        </span>
        <svg
          className="h-3 w-3 text-[color:var(--fg-muted)]"
          viewBox="0 0 12 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M1 1.5 6 6.5 11 1.5" />
        </svg>
      </motion.button>

      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute right-0 top-full z-50 mt-2 w-64 rounded-2xl border border-[color:var(--divider)] bg-[color:var(--surface)] p-3 shadow-xl"
          >
            <div className="px-2 pb-3">
              <div className="text-[10px] uppercase tracking-[0.22em] text-[color:var(--fg-subtle)]">
                {t('signedInAs')}
              </div>
              <div className="mt-1 text-sm font-semibold text-[color:var(--fg-strong)]">
                {user.display_name}
              </div>
              <div className="font-mono text-[11px] text-[color:var(--fg-muted)]">
                {user.email}
              </div>
            </div>
            <div className="border-t border-[color:var(--border)] pt-2">
              <button
                type="button"
                onClick={handleLogout}
                disabled={signingOut}
                className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm text-[color:var(--fg-strong)] transition-colors hover:bg-[color:var(--accent)]/10 disabled:opacity-50"
              >
                <span>{t('signOut')}</span>
                {signingOut ? (
                  <motion.span
                    className="h-3 w-3 rounded-full border-2 border-[color:var(--accent)] border-t-transparent"
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
                  />
                ) : (
                  <span className="text-[color:var(--highlight)] font-[900]">
                    :
                  </span>
                )}
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '··';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return (parts[0]?.slice(0, 2) ?? '··').toUpperCase();
  }
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

function firstName(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0] ?? '';
}
