'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { Cpu, KeyRound } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from './ui/Button';

/**
 * RuntimeReadinessBanner — turns the fresh-install "everything 503s" state
 * into a visible, actionable hint.
 *
 * On a fresh install the orchestrator plugin has no usable LLM access, so it
 * never publishes chatAgent@1 / orchestratorRegistry@1: every operator surface
 * (agents, channels, skills, chat) answers 503
 * `multi_orchestrator_unavailable`, and routines aren't mounted at all. The
 * individual pages then surface raw "GET … failed: 503" strings with no hint
 * at the cause. This card names the cause and links to the fix.
 *
 * Detection is a probe of one representative operator route, looking for the
 * structured 503. It re-probes on tab focus, and on a heartbeat while the
 * card is visible, so it clears itself the moment the runtime comes up.
 *
 * OM-75 (#1000) — the 503 carries a `cause`, and the copy follows it. In the
 * round-4 beta test the tester HAD a working subscription login; what was
 * missing was the orchestrator's provider assignment. The old single text
 * ("add a key or subscription") sent him back to a step he had completed, and
 * promised chat "right away" once he did. Two causes, two texts:
 *
 *   - `no_llm_access`  → no key, no OAuth, no CLI login anywhere
 *   - `no_assignment`  → access exists, the orchestrator points elsewhere
 *
 * A 503 without a cause (older middleware) renders the no-access copy.
 *
 * Mounted once in the root layout, next to SessionWatcher. Renders nothing
 * on /login + /setup.
 */

/** Heartbeat cadence while the card is visible — catches the fix landing. */
const HEARTBEAT_MS = 60 * 1000;

/** Mirrors `RuntimeReadinessCause` in middleware/src/platform/pluginLlmReadiness.ts. */
export type RuntimeReadinessCause = 'no_llm_access' | 'no_assignment' | 'unknown';

function parseCause(value: unknown): RuntimeReadinessCause {
  return value === 'no_assignment' || value === 'unknown' ? value : 'no_llm_access';
}

function isAuthPage(pathname: string): boolean {
  return pathname === '/login' || pathname === '/setup';
}

export function RuntimeReadinessBanner(): React.ReactElement | null {
  const pathname = usePathname();
  const onAuthPage = isAuthPage(pathname);

  // `null` = runtime is up (or not this card's concern); a cause = show it.
  const [cause, setCause] = useState<RuntimeReadinessCause | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const unavailable = cause !== null;

  // ── Initial probe + focus re-check + heartbeat-while-visible ────────────
  // One effect à la SessionWatcher: the probe lives inside so every
  // setState happens after an await (no sync-setState-in-effect). The
  // heartbeat is only armed while the card shows — its job is to clear the
  // card once the fix lands and the operator routes come up.
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
          setCause(null);
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          cause?: unknown;
        } | null;
        if (cancelled) return;
        setCause(
          body?.error === 'multi_orchestrator_unavailable'
            ? parseCause(body.cause)
            : null,
        );
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

  if (onAuthPage || cause === null || dismissed) return null;

  // No AnimatePresence exit animation on purpose: the card leaves when the
  // runtime comes up — an instant disappearance is fine, and it keeps the
  // clear-on-heartbeat path deterministic under fake timers in tests.
  return <ReadinessCard cause={cause} onDismiss={() => setDismissed(true)} />;
}

/** Non-blocking bottom-right card, styled after SessionWarningCard. */
function ReadinessCard({
  cause,
  onDismiss,
}: {
  cause: RuntimeReadinessCause;
  onDismiss: () => void;
}): React.ReactElement {
  const t = useTranslations('runtimeReadiness');
  // `unknown` (access + assignment line up, runtime down for another reason)
  // still gets the access copy: it is the only place in the UI that links to
  // the provider page, and the operator needs to end up there either way.
  const noAssignment = cause === 'no_assignment';
  const Icon = noAssignment ? Cpu : KeyRound;

  return (
    <motion.div
      role="alert"
      data-testid="runtime-readiness-card"
      data-cause={cause}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="fixed bottom-5 right-5 z-[80] w-[min(92vw,24rem)] border border-[color:var(--rule-strong)] bg-[color:var(--paper)] p-4 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-[color:var(--accent)]">
        <Icon className="size-3.5" aria-hidden />
        {noAssignment ? t('titleNoAssignment') : t('title')}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--ink)]">
        {noAssignment ? t('bodyNoAssignment') : t('body')}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Link
          href="/admin/providers"
          onClick={onDismiss}
          className="flex-1 border border-[color:var(--ink)] bg-[color:var(--ink)] px-3 py-2 text-center text-[11px] uppercase tracking-[0.16em] text-[color:var(--paper)] transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]"
        >
          {noAssignment ? t('ctaNoAssignment') : t('cta')}
        </Link>
        <Button
          type="button"
          variant="secondary"
          onClick={onDismiss}
          className="px-3 py-2 text-[11px] uppercase tracking-[0.16em]"
        >
          {t('dismiss')}
        </Button>
      </div>
    </motion.div>
  );
}
