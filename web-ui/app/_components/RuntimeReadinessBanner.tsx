'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { KeyRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * RuntimeReadinessBanner — turns the fresh-install "everything 503s" state
 * into a visible, actionable hint.
 *
 * On a fresh install the orchestrator plugin has no LLM API key, so it never
 * publishes chatAgent@1 / orchestratorRegistry@1: every operator surface
 * (agents, channels, skills, chat) answers 503
 * `multi_orchestrator_unavailable`, and routines aren't mounted at all. The
 * individual pages then surface raw "GET … failed: 503" strings with no hint
 * at the cause. This card names the cause and links to the fix.
 *
 * Detection is a probe of one representative operator route, looking for the
 * structured 503. It re-probes on tab focus, and on a heartbeat while the
 * card is visible, so it clears itself the moment the key is saved (the
 * operator routes go live without a restart).
 *
 * Mounted once in the root layout, next to SessionWatcher. Renders nothing
 * on /login + /setup.
 */

/** Heartbeat cadence while the card is visible — catches the key being saved. */
const HEARTBEAT_MS = 60 * 1000;

function isAuthPage(pathname: string): boolean {
  return pathname === '/login' || pathname === '/setup';
}

export function RuntimeReadinessBanner(): React.ReactElement | null {
  const pathname = usePathname();
  const onAuthPage = isAuthPage(pathname);

  const [unavailable, setUnavailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // ── Initial probe + focus re-check + heartbeat-while-visible ────────────
  // One effect à la SessionWatcher: the probe lives inside so every
  // setState happens after an await (no sync-setState-in-effect). The
  // heartbeat is only armed while the card shows — its job is to clear the
  // card once the key lands and the operator routes come up.
  useEffect(() => {
    if (onAuthPage) return;
    let cancelled = false;

    const probe = async (): Promise<void> => {
      try {
        const res = await fetch('/bot-api/v1/operator/agents', {
          credentials: 'include',
        });
        if (cancelled) return;
        if (res.status !== 503) {
          // 200 = runtime is up; 401/403 = not this card's concern.
          setUnavailable(false);
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (cancelled) return;
        setUnavailable(body?.error === 'multi_orchestrator_unavailable');
      } catch {
        // Network blip — leave state intact; the next probe retries.
      }
    };

    void probe();
    const heartbeat =
      unavailable && !dismissed
        ? window.setInterval(() => void probe(), HEARTBEAT_MS)
        : undefined;
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void probe();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (heartbeat !== undefined) window.clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [onAuthPage, unavailable, dismissed]);

  if (onAuthPage || !unavailable || dismissed) return null;

  // No AnimatePresence exit animation on purpose: the card leaves when the
  // runtime comes up — an instant disappearance is fine, and it keeps the
  // clear-on-heartbeat path deterministic under fake timers in tests.
  return <ReadinessCard onDismiss={() => setDismissed(true)} />;
}

/** Non-blocking bottom-right card, styled after SessionWarningCard. */
function ReadinessCard({
  onDismiss,
}: {
  onDismiss: () => void;
}): React.ReactElement {
  const t = useTranslations('runtimeReadiness');

  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="fixed bottom-5 right-5 z-[80] w-[min(92vw,24rem)] border border-[color:var(--rule-strong)] bg-[color:var(--paper)] p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
        <KeyRound className="size-3.5" aria-hidden />
        {t('title')}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--ink)]">
        {t('body')}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Link
          href="/admin/settings"
          onClick={onDismiss}
          className="flex-1 border border-[color:var(--ink)] bg-[color:var(--ink)] px-3 py-2 text-center text-[11px] uppercase tracking-[0.16em] text-[color:var(--paper)] transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]"
        >
          {t('cta')}
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          className="border border-[color:var(--rule-strong)] px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-[color:var(--muted-ink)] transition hover:text-[color:var(--ink)]"
        >
          {t('dismiss')}
        </button>
      </div>
    </motion.div>
  );
}
