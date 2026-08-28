'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  getTeamsSignInStatus,
  parseTeamsSignInErrorCode,
  pollTeamsSignIn,
  revokeTeamsSignIn,
  secondsRemaining,
  startTeamsSignIn,
  SIGNED_OUT_VIEW,
  type DeviceCodePendingView,
  type TeamsSignInStatusView,
} from '@/app/_lib/teamsSignIn';

/**
 * The TENANT Teams sign-in (byte5ai/omadia#924).
 *
 * WHY THIS IS A PAGE OF ITS OWN, and not a block in the agent detail panel.
 * One admin signs in once for the whole directory; every agent provisioned
 * afterwards — including ones nobody has created yet — uses that sign-in.
 * Putting it inside an agent would have said the opposite: that the sign-in
 * belongs to that agent, which is the per-agent manual step this whole change
 * exists to delete. It would also have made the natural first move — sign in
 * BEFORE creating your first agent — impossible to reach.
 *
 * THREE STATES, THREE DIFFERENT JOBS:
 *
 *   NOT SIGNED IN — one sentence on why this step exists at all (an operator
 *   who does not know that Microsoft refuses app-only catalogue uploads reads
 *   this screen as bureaucracy), and one button.
 *
 *   FLOW RUNNING — the user code, big and copyable, because it is read off one
 *   screen and typed into another; the verification link; a live countdown; and
 *   the admin-consent URL RIGHT THERE, not hidden until something fails. An
 *   admin whose sign-in page demands consent first and who has not been given
 *   that URL is simply stuck.
 *
 *   SIGNED IN — who, since when, until when, and sign out. `accessTokenStale`
 *   is rendered as a neutral note: the refresh token outlives the access token
 *   and the next upload refreshes silently, so showing it in red would send an
 *   operator to fix something that fixes itself.
 *
 * `declined` IS NEVER RENDERED AS "THE ADMIN CANCELLED". Microsoft returns it
 * for Conditional Access blocks and device-compliance failures just as readily.
 * The copy stays neutral and the server's `reason` is shown verbatim as a
 * technical line — that string is the only thing that tells the cases apart.
 *
 * NO SECRET REACHES THIS COMPONENT. The device-code `flowHandle` never leaves
 * the middleware and the poll endpoint takes no arguments — so there is nothing
 * here to guard, which is the point of putting the guarantee in the server.
 */

/** Polling stops at this age even if the server never says `expired`, so a tab
 *  left open overnight does not hammer the endpoint forever. */
const MAX_FLOW_LIFETIME_MS = 20 * 60 * 1000;

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  /** A terminal poll verdict, kept on screen until the operator acts. */
  | { readonly kind: 'expired'; readonly reason: string | null }
  | { readonly kind: 'declined'; readonly reason: string | null };

export function TeamsTenantSignIn(): React.ReactElement {
  const t = useTranslations('operatorTeamsSignIn');
  const format = useFormatter();

  const [status, setStatus] = useState<TeamsSignInStatusView>({
    supported: false,
    signIn: SIGNED_OUT_VIEW,
    pending: null,
  });
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const aliveRef = useRef(true);
  const flowStartedRef = useRef<number | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const localizeError = useCallback(
    (err: unknown): string => {
      const code = parseTeamsSignInErrorCode(err);
      return code !== null
        ? t(`errors.${code}`)
        : t('errors.unknown', {
            detail: err instanceof Error ? err.message : String(err),
          });
    },
    [t],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await getTeamsSignInStatus();
      if (!aliveRef.current) return;
      setStatus(next);
      setPhase({ kind: 'ready' });
      // A flow the server already had (this page was reopened mid-sign-in)
      // starts its lifetime clock now — losing a few minutes of budget is
      // better than never timing out.
      if (next.pending && flowStartedRef.current === null) {
        flowStartedRef.current = Date.now();
      }
    } catch (err: unknown) {
      if (!aliveRef.current) return;
      setPhase({ kind: 'ready' });
      setActionError(localizeError(err));
    }
  }, [localizeError]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = status.pending;

  // The countdown. A second ticker rather than one derived from the poll, so
  // the number keeps moving between two polls that return identical data —
  // which is the entire reason an operator believes the page is alive.
  useEffect(() => {
    if (!pending) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pending]);

  // The live poll, at the cadence Microsoft asked for.
  useEffect(() => {
    if (!pending) return undefined;
    let cancelled = false;
    const intervalMs =
      Math.max(pending.intervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS) * 1000;

    const tick = async (): Promise<void> => {
      const started = flowStartedRef.current;
      if (started !== null && Date.now() - started > MAX_FLOW_LIFETIME_MS) {
        setPhase({ kind: 'expired', reason: null });
        setStatus((prev) => ({ ...prev, pending: null }));
        return;
      }
      try {
        const result = await pollTeamsSignIn();
        if (cancelled || !aliveRef.current) return;
        switch (result.status) {
          case 'succeeded':
            flowStartedRef.current = null;
            setStatus((prev) => ({ ...prev, signIn: result.signIn, pending: null }));
            setPhase({ kind: 'ready' });
            break;
          case 'expired':
            flowStartedRef.current = null;
            setStatus((prev) => ({ ...prev, pending: null }));
            setPhase({ kind: 'expired', reason: result.reason });
            break;
          case 'declined':
            flowStartedRef.current = null;
            setStatus((prev) => ({ ...prev, pending: null }));
            setPhase({ kind: 'declined', reason: result.reason });
            break;
          case 'no_flow':
            // The server forgot the flow (a restart). Say nothing dramatic —
            // clearing the panel puts the start button back, which is the
            // only useful move left.
            flowStartedRef.current = null;
            setStatus((prev) => ({ ...prev, pending: null }));
            setPhase({ kind: 'ready' });
            break;
          case 'pending':
            break;
        }
      } catch (err: unknown) {
        if (cancelled || !aliveRef.current) return;
        setActionError(localizeError(err));
      }
    };

    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pending, localizeError]);

  async function start(): Promise<void> {
    setBusy(true);
    setActionError(null);
    setPhase({ kind: 'ready' });
    try {
      const started = await startTeamsSignIn();
      if (!aliveRef.current) return;
      flowStartedRef.current = Date.now();
      setStatus((prev) => ({ ...prev, pending: started }));
      setNow(Date.now());
    } catch (err: unknown) {
      if (aliveRef.current) setActionError(localizeError(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function signOut(): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const next = await revokeTeamsSignIn();
      if (!aliveRef.current) return;
      flowStartedRef.current = null;
      setStatus(next);
      setPhase({ kind: 'ready' });
    } catch (err: unknown) {
      if (aliveRef.current) setActionError(localizeError(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  const onCopyCode = useCallback(async (): Promise<void> => {
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.userCode);
      setCopied(true);
    } catch {
      // Soft failure (insecure context, denied permission). The code is right
      // there in selectable text — not worth an error banner.
      setCopied(false);
    }
  }, [pending]);

  const signIn = status.signIn;

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium">{t('heading')}</h2>
        <div className="ml-auto">
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            {t('refresh')}
          </Button>
        </div>
      </div>
      {/* The one sentence that turns this from bureaucracy into a reason. */}
      <p className="mb-3 text-xs text-[color:var(--fg-muted)]">{t('why')}</p>

      {actionError && (
        <div
          role="alert"
          className="mb-3 rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {actionError}
        </div>
      )}

      {phase.kind === 'loading' && (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}

      {/* A connector older than 0.6.0 is an UPGRADE, not a fault — and not the
          same message as "no connector installed". */}
      {phase.kind !== 'loading' && !status.supported && (
        <p
          role="status"
          data-testid="teams-sign-in-unsupported"
          className="mb-3 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3 text-sm text-[color:var(--fg-muted)]"
        >
          {t('unsupported')}
        </p>
      )}

      {phase.kind === 'expired' && (
        <TerminalNotice
          testId="teams-sign-in-expired"
          headline={t('expired.headline')}
          body={t('expired.body')}
          reason={phase.reason}
          reasonLabel={t('technicalReason')}
        />
      )}

      {/* NOT "the admin cancelled": a Conditional Access block lands here too,
          so the copy stays neutral and the server's reason does the telling. */}
      {phase.kind === 'declined' && (
        <TerminalNotice
          testId="teams-sign-in-declined"
          headline={t('declined.headline')}
          body={t('declined.body')}
          reason={phase.reason}
          reasonLabel={t('technicalReason')}
        />
      )}

      {phase.kind !== 'loading' && pending && (
        <PendingFlow
          flow={pending}
          now={now}
          copied={copied}
          onCopy={() => void onCopyCode()}
        />
      )}

      {phase.kind !== 'loading' && !pending && signIn.signedIn && (
        <div className="space-y-3" data-testid="teams-signed-in">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-2 py-0.5 text-xs text-[color:var(--accent)]">
              {t('signedIn.badge')}
            </span>
            <span className="text-[color:var(--fg-strong)]">
              {t('signedIn.as', {
                who:
                  signIn.account?.displayName ??
                  signIn.account?.username ??
                  t('signedIn.unknownAccount'),
              })}
            </span>
            <div className="ml-auto">
              <Button
                size="sm"
                variant="secondary"
                busy={busy}
                busyLabel={t('signOutBusy')}
                onClick={() => void signOut()}
              >
                {t('signOut')}
              </Button>
            </div>
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {signIn.signedInAt && (
              <Fact
                label={t('signedIn.since')}
                value={format.dateTime(new Date(signIn.signedInAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              />
            )}
            {signIn.expiresAt && (
              <Fact
                label={t('signedIn.tokenExpires')}
                value={format.dateTime(new Date(signIn.expiresAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              />
            )}
            {signIn.tenantId && (
              <Fact label={t('signedIn.tenant')} value={signIn.tenantId} />
            )}
            {signIn.scopes.length > 0 && (
              <Fact
                label={t('signedIn.scopes')}
                value={signIn.scopes.join(', ')}
              />
            )}
          </dl>
          {/* Deliberately NOT an alert: the refresh token outlives the access
              token, so this fixes itself on the next upload. */}
          {signIn.accessTokenStale && (
            <p
              role="status"
              data-testid="teams-token-stale"
              className="text-xs text-[color:var(--fg-muted)]"
            >
              {t('signedIn.staleNote')}
            </p>
          )}
        </div>
      )}

      {phase.kind !== 'loading' && !pending && !signIn.signedIn && (
        <div className="space-y-3" data-testid="teams-signed-out">
          <p className="text-sm text-[color:var(--fg-muted)]">
            {t('signedOut.body')}
          </p>
          <Button
            size="sm"
            busy={busy}
            disabled={!status.supported}
            busyLabel={t('startBusy')}
            onClick={() => void start()}
          >
            {t('start')}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * The running flow.
 *
 * The code is the largest thing on the page for a literal reason: it is read
 * off this screen and typed into another device. The consent URL sits beside
 * it, not behind an error, because that is the difference between an admin who
 * finishes and an admin who gets stuck on a permissions prompt.
 */
function PendingFlow(props: {
  readonly flow: DeviceCodePendingView;
  readonly now: number;
  readonly copied: boolean;
  readonly onCopy: () => void;
}): React.ReactElement {
  const t = useTranslations('operatorTeamsSignIn');
  const remaining = secondsRemaining(props.flow.expiresAt, props.now);

  return (
    <div className="space-y-3" data-testid="teams-sign-in-pending">
      <p className="text-sm text-[color:var(--fg-strong)]">{t('pending.instructions')}</p>

      <div className="flex flex-wrap items-center gap-3">
        <code
          data-testid="teams-user-code"
          aria-label={t('pending.codeLabel')}
          className="select-all rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 px-4 py-2 font-mono text-2xl tracking-[0.25em] text-[color:var(--fg-strong)]"
        >
          {props.flow.userCode}
        </code>
        <Button size="sm" variant="ghost" onClick={props.onCopy}>
          {props.copied ? t('pending.copied') : t('pending.copy')}
        </Button>
      </div>

      <p className="text-sm">
        <a
          data-testid="teams-verification-link"
          href={props.flow.verificationUri}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[color:var(--accent)] underline"
        >
          {t('pending.openVerification')}
        </a>
      </p>

      {remaining !== null && (
        <p
          data-testid="teams-code-countdown"
          className="text-xs text-[color:var(--fg-muted)]"
        >
          {t('pending.expiresIn', { seconds: remaining })}
        </p>
      )}

      {/* Shown UP FRONT, not after a failure. An admin who meets a consent
          prompt without this link has no way forward from here. */}
      {props.flow.adminConsentUrl !== '' && (
        <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3">
          <p className="text-xs text-[color:var(--fg-muted)]">
            {t('pending.consentHint')}
          </p>
          <a
            data-testid="teams-consent-link"
            href={props.flow.adminConsentUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-[color:var(--accent)] underline"
          >
            {t('pending.consentLink')}
          </a>
        </div>
      )}

      <p role="status" className="text-xs text-[color:var(--fg-muted)]">
        {t('pending.waiting')}
      </p>
    </div>
  );
}

/** A terminal poll verdict: what happened, what to do, and the raw reason. */
function TerminalNotice(props: {
  readonly testId: string;
  readonly headline: string;
  readonly body: string;
  readonly reason: string | null;
  readonly reasonLabel: string;
}): React.ReactElement {
  return (
    <div
      role="status"
      data-testid={props.testId}
      className="mb-3 space-y-1 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3"
    >
      <p className="text-sm font-medium text-[color:var(--fg-strong)]">
        {props.headline}
      </p>
      <p className="text-xs text-[color:var(--fg-muted)]">{props.body}</p>
      {props.reason !== null && (
        <p className="text-xs text-[color:var(--fg-muted)]">
          {props.reasonLabel} {props.reason}
        </p>
      )}
    </div>
  );
}

function Fact(props: {
  readonly label: string;
  readonly value: string;
}): React.ReactElement {
  return (
    <div className="flex gap-2">
      <dt className="text-[color:var(--fg-muted)]">{props.label}</dt>
      <dd className="break-all text-[color:var(--fg-strong)]">{props.value}</dd>
    </div>
  );
}
