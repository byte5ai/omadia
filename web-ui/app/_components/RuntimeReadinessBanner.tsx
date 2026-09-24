'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { Cpu, KeyRound, PlugZap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from './ui/Button';
import {
  classifyProbeResponse,
  type ReadinessCardCause,
  type ReadinessProbeBody,
} from '../_lib/runtimeReadiness';

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
 * #1088 — a fourth state the middleware can never report about itself:
 * `unreachable`. The probe used to clear the card for every `status !== 503`
 * and to swallow a thrown fetch entirely, so a stopped middleware hid the one
 * card whose job is to say the runtime cannot serve agents. Classification now
 * lives in `_lib/runtimeReadiness.ts`, shared with the dashboard's step 1 —
 * two copies of this rule are what let the two surfaces contradict each other.
 *
 * Because a transport failure can now raise the card, the dismissal is keyed
 * to the CAUSE rather than to the component: a single blip that the operator
 * waves away must not swallow a later, real `no_llm_access` 503 for the rest
 * of the session.
 *
 * Mounted once in the root layout, next to SessionWatcher. Renders nothing
 * on /login + /setup.
 */

/** Heartbeat cadence while the card is visible — catches the fix landing. */
const HEARTBEAT_MS = 60 * 1000;
// #1088 — same 10 s cap the server-rendered dashboard probe gets from
// `rscTimeoutSignal`. Without it a middleware that accepts the connection but
// never answers kept this card hidden until undici's ~300 s headers timeout,
// while dashboard step 1 already said "unreachable".
const PROBE_TIMEOUT_MS = 10 * 1000;

function isAuthPage(pathname: string): boolean {
  return pathname === '/login' || pathname === '/setup';
}

export function RuntimeReadinessBanner(): React.ReactElement | null {
  const pathname = usePathname();
  const onAuthPage = isAuthPage(pathname);

  // `null` = runtime is up (or not this card's concern); a cause = show it.
  const [cause, setCause] = useState<ReadinessCardCause | null>(null);
  // Which cause the operator waved away — not a plain boolean, so a dismissed
  // blip does not suppress a different, real cause later in the same session.
  const [dismissedCause, setDismissedCause] = useState<ReadinessCardCause | null>(
    null,
  );
  // Last-started probe wins. Two probes can be in flight (heartbeat + tab
  // focus); without this a slow failure landing after a newer success would
  // resurrect the card against a healthy backend until the next heartbeat.
  const probeSeq = useRef(0);
  const visible = cause !== null && cause !== dismissedCause;

  // ── Initial probe + focus re-check + heartbeat-while-visible ────────────
  // One effect à la SessionWatcher: the probe lives inside so every
  // setState happens after an await (no sync-setState-in-effect). The
  // heartbeat is only armed while the card shows — its job is to clear the
  // card once the fix lands and the operator routes come up.
  useEffect(() => {
    if (onAuthPage) return;
    let cancelled = false;

    const probe = async (): Promise<void> => {
      const seq = (probeSeq.current += 1);
      const stale = (): boolean => cancelled || seq !== probeSeq.current;
      const apply = (next: ReadinessCardCause | null): void => {
        setCause(next);
        // A cleared card re-arms the dismissal: the next outage is a new
        // event, not the one the operator already waved away.
        if (next === null) setDismissedCause(null);
      };
      try {
        const res = await fetch('/bot-api/v1/operator/agents', {
          credentials: 'include',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // Only the 503 carries a structured body; a proxy's HTML error page
        // has nothing to classify on, so don't read it.
        const body =
          res.status === 503
            ? ((await res.json().catch(() => null)) as ReadinessProbeBody | null)
            : null;
        if (stale()) return;
        apply(classifyProbeResponse(res.status, body));
      } catch {
        // #1088 — a thrown fetch used to leave the state intact ("network
        // blip"), which silently hid a dead backend for as long as it stayed
        // dead. It is reported as unreachable instead: the card self-clears on
        // the next heartbeat or tab focus once the middleware answers again,
        // so the cost of a genuine blip is one dismissible card.
        if (stale()) return;
        apply('unreachable');
      }
    };

    void probe();
    const heartbeat = visible
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
  }, [onAuthPage, visible]);

  if (onAuthPage || cause === null || !visible) return null;

  // No AnimatePresence exit animation on purpose: the card leaves when the
  // runtime comes up — an instant disappearance is fine, and it keeps the
  // clear-on-heartbeat path deterministic under fake timers in tests.
  return (
    <ReadinessCard cause={cause} onDismiss={() => setDismissedCause(cause)} />
  );
}

/** Non-blocking bottom-right card, styled after SessionWarningCard. */
function ReadinessCard({
  cause,
  onDismiss,
}: {
  cause: ReadinessCardCause;
  onDismiss: () => void;
}): React.ReactElement {
  const t = useTranslations('runtimeReadiness');
  // `unknown` means access AND assignment are set (that is how the middleware
  // derives it), so the no-access sentence would be a measured falsehood —
  // e.g. a stored-but-invalid key. It gets its own copy; the CTA still leads
  // to the provider page because that is where the access is checked.
  //
  // #1088 — `unreachable` deliberately does NOT reuse the `unknown` copy:
  // that text asserts "access and assignment are set", which is precisely what
  // a middleware that did not answer cannot tell us. Its CTA leads to the
  // version/update page instead of the provider page, because a stopped
  // container is not a provider problem.
  const noAssignment = cause === 'no_assignment';
  const unknown = cause === 'unknown';
  const unreachable = cause === 'unreachable';
  const Icon = unreachable ? PlugZap : noAssignment ? Cpu : KeyRound;
  const title = unreachable
    ? t('titleUnreachable')
    : noAssignment
      ? t('titleNoAssignment')
      : unknown
        ? t('titleUnknown')
        : t('title');
  const body = unreachable
    ? t('bodyUnreachable')
    : noAssignment
      ? t('bodyNoAssignment')
      : unknown
        ? t('bodyUnknown')
        : t('body');
  const href = unreachable ? '/admin/update' : '/admin/providers';
  const cta = unreachable
    ? t('ctaUnreachable')
    : noAssignment
      ? t('ctaNoAssignment')
      : t('cta');

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
        {title}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--ink)]">
        {body}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <Link
          href={href}
          onClick={onDismiss}
          className="flex-1 border border-[color:var(--ink)] bg-[color:var(--ink)] px-3 py-2 text-center text-[11px] uppercase tracking-[0.16em] text-[color:var(--paper)] transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent)]"
        >
          {cta}
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
