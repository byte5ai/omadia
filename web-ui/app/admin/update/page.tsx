'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

import {
  ApiError,
  getUpdateHistory,
  getUpdateStatus,
  triggerUpdate,
  type UpdateAuditEntry,
  type UpdateStatus,
} from '../../_lib/api';

/**
 * Admin → Update (#432).
 *
 * Reports the running build, whether a newer release exists, and — only when
 * the opt-in updater overlay is deployed — lets the operator move the stack to
 * a chosen version behind a type-to-confirm gate (re-checked server-side, like
 * the Danger Zone).
 *
 * Two behaviours that are not cosmetic:
 *
 *   - Polling, not awaiting. Applying an update recreates the container that
 *     served the request, so the trigger answers 202 and this page then polls
 *     `/status` through the restart. Errors during that window are expected,
 *     not failures, and are swallowed while an update is in flight.
 *   - Honest capability reporting. With no executor configured the page says
 *     so and shows the manual command instead of offering a button that would
 *     answer 409.
 */

/**
 * Idle polling is slow on purpose: every `/status` call also settles open audit
 * rows (two UPDATEs) and pings the sidecar, and a version number does not
 * change while nobody is updating. The fast cadence is only for the window
 * where the middleware is being replaced and the page has to notice it return.
 */
const IDLE_POLL_MS = 30_000;
const ACTIVE_POLL_MS = 4_000;

/** Error codes the backend returns for a refused trigger. Anything else falls
 *  back to the generic message with the technical detail behind it. */
const KNOWN_ERRORS = new Set([
  'confirmation_mismatch',
  'invalid_target_version',
  'updater_not_configured',
  'audit_unavailable',
  'update_in_progress',
  'already_on_target',
  'updater_unreachable',
  'updater_rejected',
  'audit_write_failed',
]);

export default function UpdatePage(): React.ReactElement {
  const t = useTranslations('adminUpdate');

  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [history, setHistory] = useState<UpdateAuditEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [confirmInput, setConfirmInput] = useState('');
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [awaitingRestart, setAwaitingRestart] = useState(false);

  // Read inside the interval callback without making it a dependency — the
  // poll must not be torn down and rebuilt on every status change. Mirrored in
  // an effect rather than assigned during render (refs are not render state).
  const awaitingRef = useRef(false);
  useEffect(() => {
    awaitingRef.current = awaitingRestart;
  }, [awaitingRestart]);

  const load = useCallback(async (refresh = false): Promise<void> => {
    try {
      const next = await getUpdateStatus(refresh);
      setStatus(next);
      setLoadError(null);
      if (next.auditAvailable) {
        const trail = await getUpdateHistory();
        setHistory(trail.entries);
      }
    } catch (err) {
      // While the stack is restarting the middleware is legitimately gone;
      // surfacing that as an error would make a working update look broken.
      if (!awaitingRef.current) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  const active = awaitingRestart || status?.executor.state === 'updating';

  useEffect(() => {
    void load();
    const timer = setInterval(
      () => { void load(); },
      active ? ACTIVE_POLL_MS : IDLE_POLL_MS,
    );
    return () => { clearInterval(timer); };
    // `active` is a dependency on purpose: the timer is rebuilt when the page
    // switches cadence, which is the only time the interval should change.
  }, [load, active]);

  const target = status?.latest?.tag ?? '';
  const executorReady =
    status?.executor.configured === true && status.executor.reachable;
  const updating = status?.executor.state === 'updating';

  // The restart is over once the running build IS the target.
  useEffect(() => {
    if (!awaitingRestart || !status) return;
    if (status.current.version === target && target.length > 0) {
      setAwaitingRestart(false);
      setConfirmInput('');
    }
  }, [awaitingRestart, status, target]);

  const confirmMatches = useMemo(
    () =>
      target.length > 0 &&
      confirmInput.trim().replace(/^v/, '') === target.replace(/^v/, ''),
    [confirmInput, target],
  );

  const canTrigger =
    status?.updateAvailable === true &&
    executorReady &&
    status.auditAvailable &&
    confirmMatches &&
    !triggering &&
    !updating &&
    !awaitingRestart;

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  const onTrigger = useCallback(async (): Promise<void> => {
    if (!confirmMatches) return;
    setTriggering(true);
    setTriggerError(null);
    try {
      await triggerUpdate({ targetVersion: target, confirm: confirmInput.trim() });
      // From here the middleware is expected to disappear and come back on the
      // new image; polling takes over.
      setAwaitingRestart(true);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      setTriggerError(
        code !== null && KNOWN_ERRORS.has(code)
          ? t(`errors.${code}`)
          : t('errors.generic', {
              message: err instanceof Error ? err.message : String(err),
            }),
      );
    } finally {
      setTriggering(false);
    }
  }, [confirmInput, confirmMatches, target, t]);

  return (
    <main className="mx-auto max-w-[800px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <Link
          href="/admin"
          className="text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
        >
          ← /admin
        </Link>
        <h1 className="mt-2 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[16px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </header>

      {loadError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {t('loadError', { message: loadError })}
        </section>
      )}

      <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        <h2 className="mb-3 text-[10px] font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">
          {t('versionsTitle')}
        </h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-[color:var(--fg-muted)]">{t('running')}</dt>
          <dd className="font-mono">
            {status?.current.version ?? '…'}
            {status?.current.source === 'unknown' && (
              <span className="ml-2 font-sans text-xs text-[color:var(--fg-muted)]">
                {t('unstamped')}
              </span>
            )}
            {status?.current.source === 'floating' && (
              <span className="ml-2 font-sans text-xs text-[color:var(--fg-muted)]">
                {t('floating')}
              </span>
            )}
          </dd>
          <dt className="text-[color:var(--fg-muted)]">{t('latest')}</dt>
          <dd className="font-mono">
            {status?.latest === null || status === null ? (
              t('latestUnknown')
            ) : (
              <a
                href={status.latest.url}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted"
              >
                {status.latest.tag}
              </a>
            )}
          </dd>
        </dl>

        {status?.updateAvailable === true && (
          <p className="mt-3 rounded border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 p-2 text-sm">
            {t('updateAvailable', { version: target })}
          </p>
        )}
        {status !== null && !status.updateAvailable && status.current.source === 'release' && (
          <p className="mt-3 text-sm text-[color:var(--fg-muted)]">{t('upToDate')}</p>
        )}
        {status?.check.stale === true && (
          <p className="mt-3 text-xs text-[color:var(--fg-muted)]">
            {t('checkStale')}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onRefresh()}
            disabled={refreshing}
          >
            {refreshing ? t('checking') : t('checkNow')}
          </Button>
        </div>
      </section>

      {status !== null && !status.executor.configured && (
        <section className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4 text-sm">
          <h2 className="mb-2 text-[10px] font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">
            {t('notifyOnlyTitle')}
          </h2>
          <p className="text-[color:var(--fg-muted)]">{t('notifyOnlyBody')}</p>
          {/* Labelled per platform: the executor is compose-only, so an
              unlabelled `docker compose` line would be actively misleading on
              a Fly.io or Kubernetes deployment, which reach this same state. */}
          <p className="mt-3 text-[11px] tracking-wider text-[color:var(--fg-muted)] uppercase">
            {t('notifyOnlyComposeLabel')}
          </p>
          <pre className="mt-1 overflow-x-auto rounded bg-[color:var(--bg)] p-3 font-mono text-xs">
            {`OMADIA_VERSION=${target.length > 0 ? target : 'vX.Y.Z'} docker compose up -d`}
          </pre>
          <p className="mt-3 text-[11px] tracking-wider text-[color:var(--fg-muted)] uppercase">
            {t('notifyOnlyFlyLabel')}
          </p>
          <pre className="mt-1 overflow-x-auto rounded bg-[color:var(--bg)] p-3 font-mono text-xs">
            {`fly deploy --app <middleware-app> --config fly/middleware.fly.toml \\\n  --image ghcr.io/byte5ai/omadia-middleware:${target.length > 0 ? target : 'vX.Y.Z'}`}
          </pre>
          <p className="mt-3 text-xs text-[color:var(--fg-muted)]">
            {t('notifyOnlyDocsHint')}
          </p>
        </section>
      )}

      {status?.executor.configured === true && !status.executor.reachable && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {t('executorUnreachable', { message: status.executor.error ?? '' })}
        </section>
      )}

      {status?.executor.configured === true && status.auditAvailable === false && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)]/50 bg-[color:var(--danger)]/5 p-4 text-sm text-[color:var(--danger)]">
          {t('auditUnavailable')}
        </section>
      )}

      {(updating || awaitingRestart) && (
        <section className="mb-6 rounded-lg border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 p-4 text-sm">
          <h2 className="mb-2 text-[10px] font-semibold tracking-wider uppercase">
            {t('inProgressTitle')}
          </h2>
          <p>{t('inProgressBody')}</p>
          {(status?.executor.steps ?? []).length > 0 && (
            <ol className="mt-3 max-h-48 overflow-y-auto font-mono text-xs text-[color:var(--fg-muted)]">
              {(status?.executor.steps ?? []).map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </section>
      )}

      {status?.executor.state === 'rolled_back' && !awaitingRestart && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {t('rolledBack', { message: status.executor.error ?? '' })}
        </section>
      )}

      {executorReady && status?.updateAvailable === true && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)]/50 bg-[color:var(--danger)]/5 p-4">
          <h2 className="mb-3 text-[10px] font-semibold tracking-wider text-[color:var(--danger)] uppercase">
            {t('confirmTitle')}
          </h2>
          <p className="mb-2 text-sm text-[color:var(--fg-muted)]">
            {t.rich('confirmInstruction', {
              phrase: target,
              code: (chunks) => (
                <code className="rounded bg-[color:var(--danger)]/15 px-2 py-0.5 font-mono text-[color:var(--danger)]">
                  {chunks}
                </code>
              ),
            })}
          </p>
          <p className="mb-2 text-xs text-[color:var(--fg-muted)]">
            {t('confirmWarning')}
          </p>
          <input
            type="text"
            value={confirmInput}
            onChange={(e) => { setConfirmInput(e.target.value); }}
            placeholder={target}
            disabled={triggering || updating || awaitingRestart}
            aria-label={t('confirmInputLabel')}
            className="w-full rounded border border-[color:var(--danger-edge)] px-2 py-2 font-mono text-sm"
          />
          <div className="mt-4 flex items-center justify-end">
            <Button
              variant="danger"
              onClick={() => void onTrigger()}
              disabled={!canTrigger}
            >
              {triggering ? t('triggering') : t('triggerButton', { version: target })}
            </Button>
          </div>
        </section>
      )}

      {triggerError !== null && (
        <section className="mb-6 rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {triggerError}
        </section>
      )}

      {status?.auditAvailable === true && history.length > 0 && (
        <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
          <h2 className="mb-3 text-[10px] font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">
            {t('historyTitle')}
          </h2>
          <ul className="flex flex-col gap-2 text-sm">
            {history.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline gap-x-3 border-b border-[color:var(--border)]/50 pb-2 last:border-0"
              >
                <span className="font-mono">
                  {entry.fromVersion} → {entry.toVersion}
                </span>
                <span className="text-xs text-[color:var(--fg-muted)]">
                  {t(`outcomes.${entry.outcome}`)}
                </span>
                <span className="text-xs text-[color:var(--fg-muted)]">
                  {entry.actor}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
