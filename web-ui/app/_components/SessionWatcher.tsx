'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Clock, LogIn } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { getSessionStatus } from '../_lib/api';

/**
 * SessionWatcher — turns the previously *silent* session logout into a
 * visible one.
 *
 * The `omadia_session` cookie is a 4h JWT with no refresh. The edge proxy
 * catches an expired cookie on navigation and `api.ts` catches it on a 401
 * from an API call — but a tab that is sitting idle (no navigation, no API
 * call) just goes dead with no signal. This component closes that gap:
 *
 *   - It learns the session's `exp` from GET /api/v1/auth/me (skew-corrected
 *     against the server clock) and schedules two transitions: a warning
 *     ~5 min before expiry and the hard logout at expiry.
 *   - A 60s heartbeat (plus an immediate re-check whenever the tab regains
 *     focus) also catches server-side revocation — account disabled, key
 *     rotation — which the local expiry clock alone cannot see.
 *   - At expiry it shows a blocking overlay instead of leaving the operator
 *     staring at a frozen UI. No silent auto-extend: re-login is explicit.
 *
 * Mounted once in the root layout. Renders nothing on the /login + /setup
 * pages (no session to watch there).
 */

/** How long before expiry the (non-blocking) warning card appears. */
const WARN_BEFORE_MS = 5 * 60 * 1000;
/** Heartbeat cadence — the only thing that can see server-side revocation. */
const HEARTBEAT_MS = 60 * 1000;

type Phase = 'normal' | 'warning' | 'expired';
const PHASE_RANK: Record<Phase, number> = { normal: 0, warning: 1, expired: 2 };

function isAuthPage(pathname: string): boolean {
  return pathname === '/login' || pathname === '/setup';
}

/** Format a millisecond duration as `M:SS` (clamped at zero). */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes.toString()}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Bounce to the login page to re-authenticate, preserving the current
 * location as `return`.
 *
 * The `reauth=1` flag marks this as an *explicit* re-login. During the
 * warning phase the current session is still (briefly) valid, so without
 * this flag the login page would see a live session and immediately bounce
 * back here — making the "Relogin now" button look like it does nothing.
 * The flag tells /login to show the form regardless.
 */
function relogin(): void {
  const target = window.location.pathname + window.location.search;
  const query = new URLSearchParams({ return: target, reauth: '1' });
  window.location.assign(`/login?${query.toString()}`);
}

export function SessionWatcher(): React.ReactElement | null {
  const pathname = usePathname();
  const onAuthPage = isAuthPage(pathname);

  const [phase, setPhase] = useState<Phase>('normal');
  // Session expiry translated into THIS browser's clock (skew-corrected).
  // null until the first probe resolves.
  const [expiresAtLocal, setExpiresAtLocal] = useState<number | null>(null);
  const [warningDismissed, setWarningDismissed] = useState(false);

  // Phase only ever advances. A warn-timer that fires late (e.g. after the
  // heartbeat already detected revocation and jumped to 'expired') must not
  // pull the state backwards.
  const advancePhase = useCallback((next: Phase) => {
    setPhase((cur) => (PHASE_RANK[next] > PHASE_RANK[cur] ? next : cur));
  }, []);

  // ── Initial probe + heartbeat + focus re-check ─────────────────────────
  useEffect(() => {
    if (onAuthPage) return;
    let cancelled = false;

    const probe = async (): Promise<void> => {
      try {
        const status = await getSessionStatus();
        if (cancelled) return;
        if (
          !status.authenticated ||
          status.expiresAt === null ||
          status.serverNow === null
        ) {
          advancePhase('expired');
          return;
        }
        // Re-express the server's expiry in the local clock so the
        // countdown is correct even when this machine's clock drifts.
        const skewMs = Date.now() - status.serverNow * 1000;
        const nextExpiry = status.expiresAt * 1000 + skewMs;
        setExpiresAtLocal((prev) =>
          prev !== null && Math.abs(prev - nextExpiry) < 2000
            ? prev
            : nextExpiry,
        );
        // Catch up if the tab was loaded (or woke from sleep) already
        // inside a warning/expired window — the scheduled timers below
        // only cover transitions that are still in the future.
        const remaining = nextExpiry - Date.now();
        if (remaining <= 0) advancePhase('expired');
        else if (remaining <= WARN_BEFORE_MS) advancePhase('warning');
      } catch {
        // Network blip — leave state intact; the next heartbeat retries.
      }
    };

    void probe();
    const heartbeat = window.setInterval(() => void probe(), HEARTBEAT_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void probe();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [onAuthPage, advancePhase]);

  // ── Schedule the warning + expiry transitions ──────────────────────────
  // Only arms future-dated timers; the probe above handles the case where
  // the page is already inside a window. Keeping setState out of the effect
  // body (timer callbacks run asynchronously) avoids cascading renders.
  useEffect(() => {
    if (onAuthPage || expiresAtLocal === null) return;

    const remaining = expiresAtLocal - Date.now();
    const timers: number[] = [];
    if (remaining > WARN_BEFORE_MS) {
      timers.push(
        window.setTimeout(
          () => advancePhase('warning'),
          remaining - WARN_BEFORE_MS,
        ),
      );
    }
    if (remaining > 0) {
      timers.push(window.setTimeout(() => advancePhase('expired'), remaining));
    }
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [onAuthPage, expiresAtLocal, advancePhase]);

  if (onAuthPage) return null;

  return (
    <AnimatePresence>
      {phase === 'expired' ? (
        <SessionExpiredOverlay key="expired" />
      ) : phase === 'warning' &&
        !warningDismissed &&
        expiresAtLocal !== null ? (
        <SessionWarningCard
          key="warning"
          expiresAtLocal={expiresAtLocal}
          onDismiss={() => setWarningDismissed(true)}
        />
      ) : null}
    </AnimatePresence>
  );
}

/** Non-blocking bottom-right card with a live countdown to expiry. */
function SessionWarningCard({
  expiresAtLocal,
  onDismiss,
}: {
  expiresAtLocal: number;
  onDismiss: () => void;
}): React.ReactElement {
  const t = useTranslations('session');
  const [remaining, setRemaining] = useState(
    () => expiresAtLocal - Date.now(),
  );

  useEffect(() => {
    const tick = window.setInterval(() => {
      setRemaining(expiresAtLocal - Date.now());
    }, 1000);
    return () => window.clearInterval(tick);
  }, [expiresAtLocal]);

  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="fixed bottom-5 right-5 z-[90] w-[min(92vw,22rem)] border border-[color:var(--rule-strong)] bg-[color:var(--paper)] p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
        <Clock className="size-3.5" aria-hidden />
        {t('warningTitle')}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--ink)]">
        {t('warningBody', { time: formatClock(remaining) })}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={relogin}
          className="flex-1 border border-[color:var(--ink)] bg-[color:var(--ink)] px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-[color:var(--paper)] transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]"
        >
          {t('warningCta')}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="border border-[color:var(--rule-strong)] px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-[color:var(--muted-ink)] transition hover:text-[color:var(--ink)]"
        >
          {t('warningDismiss')}
        </button>
      </div>
    </motion.div>
  );
}

/** Blocking full-screen overlay shown once the session is gone. */
function SessionExpiredOverlay(): React.ReactElement {
  const t = useTranslations('session');
  const ctaRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    ctaRef.current?.focus();
  }, []);

  return (
    <motion.div
      role="alertdialog"
      aria-modal="true"
      aria-label={t('expiredTitle')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 py-6"
    >
      <div className="absolute inset-0 bg-[color:var(--ink)]/55 backdrop-blur-sm" />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-md border border-[color:var(--rule-strong)] bg-[color:var(--paper)] p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.5)]"
      >
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
          <Clock className="size-3.5" aria-hidden />
          {t('expiredKicker')}
        </div>
        <h2 className="font-display mt-1 text-2xl font-medium leading-tight text-[color:var(--ink)]">
          {t('expiredTitle')}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--muted-ink)]">
          {t('expiredBody')}
        </p>
        <button
          ref={ctaRef}
          type="button"
          onClick={relogin}
          className="mt-4 flex w-full items-center justify-center gap-2 border border-[color:var(--ink)] bg-[color:var(--ink)] px-4 py-3 text-[12px] uppercase tracking-[0.16em] text-[color:var(--paper)] transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]"
        >
          <LogIn className="size-3.5" aria-hidden />
          {t('expiredCta')}
        </button>
      </motion.div>
    </motion.div>
  );
}
