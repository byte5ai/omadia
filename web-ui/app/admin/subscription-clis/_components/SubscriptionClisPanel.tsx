'use client';

/**
 * `/admin/subscription-clis` — "Subscription CLIs" admin page (#309, Phase B).
 *
 * Lets a self-hoster see which vendor LLM CLIs (Claude / Codex / Gemini) are
 * installed and logged in, and connect one via an in-app login flow (no
 * terminal), so they can run agents on a subscription they already pay for
 * instead of a metered API key. Aimed at a first-time self-hoster: clear status,
 * one-click connect, honest caveats.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '../../../_components/ui/Button';
import {
  getCliBackends,
  startCliLogin,
  submitCliLoginCode,
  cancelCliLogin,
  cliLogout,
  type CliBackendsResponse,
  type CliBackendStatus,
} from '../../../_lib/api';
import { InstallBox, ManualInstallSteps } from './InstallBox';

type T = ReturnType<typeof useTranslations>;

/** How long the "aktualisiert" confirmation stays on screen after a re-check. */
const REFRESH_CONFIRMATION_MS = 4000;

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: CliBackendsResponse }
  | { kind: 'error'; message: string };

export function SubscriptionClisPanel({
  onSwitchToProviders,
}: {
  /**
   * Switch the parent tab strip over to the API-keys panel.
   *
   * Required on purpose (OM-05/38): this panel used to link to
   * `/admin/providers?tab=providers`, but it is *already* mounted on that
   * route and the active tab lives in `LlmAccessTabs`' local state, seeded
   * once on mount. Same route ⇒ no remount ⇒ the link just reloaded the page
   * and left the operator staring at the same tab. Making the callback
   * mandatory means the panel can never again be mounted without a way back —
   * the compiler enforces the symmetry with `onSwitchToSubscriptions`.
   */
  readonly onSwitchToProviders: () => void;
}): React.ReactElement {
  const t = useTranslations('adminSubscriptionClis');
  const format = useFormatter();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [rechecking, setRechecking] = useState(false);
  /**
   * OM-22 — "Erneut prüfen" appeared to do nothing.
   *
   * The report blamed a missing spinner, but a busy state already exists (see
   * `<Button busy>` below); it is simply invisible because a local `--version`
   * probe finishes in well under 100 ms. The real defect is that a re-check
   * whose RESULT is unchanged produces no observable change at all. So: show
   * when the snapshot was taken (`generatedAt` was already on the wire and had
   * zero render sites), plus a short-lived confirmation so "nothing changed"
   * still reads as "something happened".
   */
  const [justRefreshed, setJustRefreshed] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const load = useCallback(async (force: boolean) => {
    if (force) setRechecking(true);
    try {
      const data = await getCliBackends(force);
      setState({ kind: 'ready', data });
      if (force) {
        setJustRefreshed(true);
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(
          () => setJustRefreshed(false),
          REFRESH_CONFIRMATION_MS,
        );
      }
    } catch (err) {
      // Keep a prior good snapshot visible; only show the full error on first load.
      setState((prev) =>
        prev.kind === 'ready'
          ? prev
          : { kind: 'error', message: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      if (force) setRechecking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await getCliBackends(false);
        if (!cancelled) setState({ kind: 'ready', data });
      } catch (err) {
        if (!cancelled) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <p className="mb-8 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
        {t('intro')}
      </p>

      <div className="mb-8 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <div className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
          {t('explainer.heading')}
        </div>
        <p className="mt-2 text-sm leading-[1.55] text-[color:var(--fg-muted)]">{t('explainer.body')}</p>
        <p className="mt-2 text-sm leading-[1.55] text-[color:var(--fg-muted)]">
          {t('explainer.singleOperator')}
        </p>
        <p className="mt-3 text-sm">
          {/* eslint-disable-next-line no-restricted-syntax -- inline text link (underline, no border/bg) */}
          <button
            type="button"
            onClick={onSwitchToProviders}
            className="font-medium text-[color:var(--accent)] underline"
          >
            {t('selectModelLink')} →
          </button>
        </p>
      </div>

      {state.kind === 'loading' && (
        <p className="text-sm text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}
      {state.kind === 'error' && (
        <p className="text-sm text-[color:var(--danger)]">{t('loadError', { message: state.message })}</p>
      )}

      {state.kind === 'ready' && (
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
              {t('detected.heading')}
            </h2>
            <div className="flex items-center gap-3">
              {/* OM-22 — the evidence that the re-check actually ran. */}
              <span
                className="text-[12px] text-[color:var(--fg-muted)]"
                data-testid="cli-last-checked"
              >
                {justRefreshed
                  ? t('refreshed')
                  : t('lastChecked', {
                      time: format.dateTime(new Date(state.data.generatedAt), {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      }),
                    })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                busy={rechecking}
                busyLabel={t('rechecking')}
                onClick={() => void load(true)}
              >
                {t('recheck')}
              </Button>
            </div>
          </div>
          <ul className="flex flex-col gap-3">
            {state.data.backends.map((b) => (
              <CliRow
                key={b.id}
                b={b}
                cliToolsDir={state.data.cliToolsDir}
                t={t}
                onChanged={() => void load(true)}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

type LoginPhase =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'awaiting'; sessionId: string; url: string }
  | { phase: 'submitting'; sessionId: string; url: string }
  | { phase: 'error'; message: string; sessionId?: string; url?: string };

function CliRow({
  b,
  cliToolsDir,
  t,
  onChanged,
}: {
  b: CliBackendStatus;
  cliToolsDir: string;
  t: T;
  onChanged: () => void;
}): React.ReactElement {
  const [login, setLogin] = useState<LoginPhase>({ phase: 'idle' });
  const [code, setCode] = useState('');
  const [busyLogout, setBusyLogout] = useState(false);

  const statusLine = !b.installed
    ? t('status.notInstalled')
    : b.loggedIn === 'yes'
      ? b.account
        ? t('status.loggedInAs', { account: b.account })
        : t('status.loggedIn')
      : b.loggedIn === 'no'
        ? t('status.installedNotLoggedIn')
        : t('status.installedUnknown');

  const onConnect = async (): Promise<void> => {
    setLogin({ phase: 'starting' });
    setCode('');
    try {
      const { sessionId, verificationUrl } = await startCliLogin(b.id);
      setLogin({ phase: 'awaiting', sessionId, url: verificationUrl });
    } catch (err) {
      setLogin({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const onSubmitCode = async (sessionId: string, url: string): Promise<void> => {
    if (!code.trim()) return;
    setLogin({ phase: 'submitting', sessionId, url });
    try {
      const res = await submitCliLoginCode(b.id, sessionId, code.trim());
      if (res.status === 'authorized') {
        setLogin({ phase: 'idle' });
        setCode('');
        onChanged();
      } else if (res.status === 'pending') {
        // Code accepted but the CLI hadn't flipped to logged-in within the
        // backend window. Keep polling detection before giving up, so a slower
        // real sign-in still resolves to success without the user re-submitting.
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const snap = await getCliBackends(true);
          if (snap.backends.find((x) => x.id === b.id)?.loggedIn === 'yes') {
            setLogin({ phase: 'idle' });
            setCode('');
            onChanged();
            return;
          }
        }
        setLogin({ phase: 'error', message: t('connect.stillPending'), sessionId, url });
      } else {
        setLogin({ phase: 'error', message: res.error ?? t('connect.failed'), sessionId, url });
      }
    } catch (err) {
      setLogin({ phase: 'error', message: err instanceof Error ? err.message : String(err), sessionId, url });
    }
  };

  const onCancel = (): void => {
    void cancelCliLogin(b.id);
    setLogin({ phase: 'idle' });
    setCode('');
  };

  const onLogout = async (): Promise<void> => {
    setBusyLogout(true);
    try {
      await cliLogout(b.id);
      onChanged();
    } finally {
      setBusyLogout(false);
    }
  };

  const canConnect = b.installed && b.billing === 'subscription' && b.loggedIn !== 'yes';

  return (
    <li className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-[color:var(--fg-strong)]">{b.label}</span>
          <code className="text-[12px] text-[color:var(--fg-muted)]">{b.bin}</code>
          {b.version ? (
            <span className="text-[12px] text-[color:var(--fg-muted)]">{t('version', { version: b.version })}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <InstallBadge installed={b.installed} loggedIn={b.loggedIn} t={t} />
          <BillingBadge billing={b.billing} t={t} />
        </div>
      </div>
      <p className="mt-2 text-sm text-[color:var(--fg-muted)]">{statusLine}</p>

      {/* OM-11 — the dead end.
          The install instructions used to live INSIDE the `canConnect` gate
          (`b.installed && …`), i.e. they were hidden precisely when
          `!b.installed` — exactly the state in which the user needs them. A
          customer clicked "Anmelden →", landed on "NICHT GEFUNDEN – In dieser
          Umgebung nicht installiert", and had no button, no instructions, and
          no way to get the CLI onto the server.
          Rendered open (not a `<details>`) here: when the CLI is missing this
          IS the only available action, so it must not be one more click away. */}
      {!b.installed && (
        <div className="mt-3 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)]/40 p-3">
          <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
            {t('install.heading')}
          </div>
          {b.installable ? (
            <InstallBox
              b={b}
              cliToolsDir={cliToolsDir}
              t={t}
              onChanged={onChanged}
            />
          ) : (
            <>
              <p className="mt-2 text-sm text-[color:var(--fg-muted)]">{t('install.intro')}</p>
              <ManualInstallSteps b={b} cliToolsDir={cliToolsDir} t={t} />
            </>
          )}
        </div>
      )}

      {/* Logged in → offer logout. */}
      {b.loggedIn === 'yes' && (
        <div className="mt-3">
          <Button variant="ghost" size="sm" busy={busyLogout} busyLabel={t('logout.busy')} onClick={() => void onLogout()}>
            {t('logout.button')}
          </Button>
        </div>
      )}

      {/* In-app login flow for a connectable (Claude) CLI. */}
      {canConnect && (
        <div className="mt-3 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)]/40 p-3">
          {login.phase === 'idle' && (
            <div>
              <Button variant="primary" size="sm" onClick={() => void onConnect()}>
                {t('connect.button')}
              </Button>
              <details className="mt-3">
                <summary className="cursor-pointer text-[12px] text-[color:var(--fg-muted)]">
                  {t('connect.manualSummary')}
                </summary>
                <ManualInstallSteps b={b} cliToolsDir={cliToolsDir} t={t} />
              </details>
            </div>
          )}

          {login.phase === 'starting' && (
            <p className="text-sm text-[color:var(--fg-muted)]">{t('connect.starting')}</p>
          )}

          {(login.phase === 'awaiting' || login.phase === 'submitting' || (login.phase === 'error' && login.url)) && (
            <div>
              <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
                {t('connect.heading')}
              </div>
              <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-[color:var(--fg-muted)]">
                <li>
                  {t('connect.openHint')}{' '}
                  {'url' in login && login.url ? (
                    <a
                      href={login.url}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-[color:var(--accent)] underline"
                    >
                      {t('connect.openLink')}
                    </a>
                  ) : null}
                </li>
                <li>
                  {t('connect.pasteHint')}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder={t('connect.codePlaceholder')}
                      className="min-w-[260px] flex-1 rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-1.5 text-sm text-[color:var(--fg-strong)]"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      busy={login.phase === 'submitting'}
                      busyLabel={t('connect.submitting')}
                      onClick={() => {
                        const sid = 'sessionId' in login ? login.sessionId : undefined;
                        const url = 'url' in login ? login.url : undefined;
                        if (sid && url) void onSubmitCode(sid, url);
                      }}
                    >
                      {t('connect.submit')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={onCancel}>
                      {t('connect.cancel')}
                    </Button>
                  </div>
                </li>
              </ol>
              {login.phase === 'error' && (
                <p className="mt-2 text-sm text-[color:var(--danger)]">{login.message}</p>
              )}
            </div>
          )}

          {login.phase === 'error' && !login.url && (
            <div>
              <p className="text-sm text-[color:var(--danger)]">{login.message}</p>
              <div className="mt-2">
                <Button variant="secondary" size="sm" onClick={() => void onConnect()}>
                  {t('connect.retry')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {b.billing === 'needs-verification' && (
        <p className="mt-2 rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-3 py-2 text-[12px] text-[color:var(--warning)]">
          {t('needsVerificationNote')}
        </p>
      )}
    </li>
  );
}

function InstallBadge({
  installed,
  loggedIn,
  t,
}: {
  installed: boolean;
  loggedIn: CliBackendStatus['loggedIn'];
  t: T;
}): React.ReactElement {
  const [label, cls] = !installed
    ? [t('badge.notInstalled'), 'bg-[color:var(--border)]/40 text-[color:var(--fg-muted)]']
    : loggedIn === 'yes'
      ? [t('badge.loggedIn'), 'bg-[color:var(--success)]/10 text-[color:var(--success)]']
      : loggedIn === 'no'
        ? [t('badge.needsLogin'), 'bg-[color:var(--warning)]/10 text-[color:var(--warning)]']
        : [t('badge.installed'), 'bg-[color:var(--border)]/40 text-[color:var(--fg-muted)]'];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em] ${cls}`}
    >
      {label}
    </span>
  );
}

/**
 * OM-48 (#887) — this sits beside InstallBadge.
 * Without an "Abrechnung:"/"Billing:" prefix, the pair can read like
 * conflicting detection statuses, even though this badge describes billing
 * posture rather than whether the CLI was found.
 */
function BillingBadge({
  billing,
  t,
}: {
  billing: CliBackendStatus['billing'];
  t: T;
}): React.ReactElement {
  const [label, cls] =
    billing === 'subscription'
      ? [t('badge.subscription'), 'bg-[color:var(--success)]/10 text-[color:var(--success)]']
      : [t('badge.needsVerification'), 'bg-[color:var(--warning)]/10 text-[color:var(--warning)]'];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] uppercase tracking-[0.16em] ${cls}`}
    >
      {label}
    </span>
  );
}
