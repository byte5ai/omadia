'use client';

import { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

import type { UpdateStatus } from '../../../_lib/api';

import {
  decodeFailure,
  describesThisRun,
  stepStates,
  UPDATE_STEPS,
  type InflightUpdate,
  type Outcome,
  type StepState,
} from './updateFailure';

/**
 * Blocking progress dialog for a running update (#432 follow-up).
 *
 * While an update is in flight the rest of the admin page is not usable in
 * any meaningful way — the middleware behind it is being replaced — so the
 * dialog covers the page and cannot be dismissed until the job reached a
 * terminal state. What it shows is deliberately honest about the mechanics:
 *
 *   - a stepper driven by the sidecar's `phase`, not by guessing from text
 *   - the polling itself: cadence, when the last answer came, and whether the
 *     middleware is currently unreachable (expected during the restart, and
 *     shown as such rather than as an error)
 *   - the outcome decoded from the structured `failure`, with the likely cause
 *     spelled out for the case that actually happens in the field — a new
 *     image that never came up because it needs a secret the old one did not
 *
 * Lume: state colours are text/edge only, progress is text + the busy-dots
 * exception, no spinners.
 */

const DOCS_UPGRADING_URL =
  'https://github.com/byte5ai/omadia/blob/main/docs/upgrading.md';
/** After this long without a terminal state the dialog offers a way out; the
 *  sidecar's own health gate is 5 min, so 12 min covers pull + gate + rollback. */
const STALL_AFTER_MS = 12 * 60_000;

export interface PollingInfo {
  readonly intervalMs: number;
  /** Epoch ms of the last `/status` attempt, null before the first. */
  readonly lastAttemptAt: number | null;
  /** Epoch ms of the last SUCCESSFUL `/status`, null if none since open. */
  readonly lastOkAt: number | null;
  readonly attempts: number;
}

export interface UpdateProgressModalProps {
  readonly inflight: InflightUpdate;
  readonly status: UpdateStatus | null;
  readonly outcome: Outcome;
  readonly polling: PollingInfo;
  readonly onClose: () => void;
  readonly onReload: () => void;
}

function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, tickMs);
    return () => { clearInterval(timer); };
  }, [tickMs]);
  return now;
}

function formatElapsed(ms: number, seconds: (n: number) => string): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : seconds(s);
}

const STEP_GLYPH: Record<StepState, string> = {
  done: '✓',
  current: '›',
  pending: '·',
  failed: '✕',
};

const STEP_CLASS: Record<StepState, string> = {
  done: 'text-[color:var(--fg-muted)]',
  current: 'text-[color:var(--fg-strong)] font-medium',
  pending: 'text-[color:var(--fg-subtle)]',
  failed: 'text-[color:var(--danger)] font-medium',
};

export function UpdateProgressModal({
  inflight,
  status,
  outcome,
  polling,
  onClose,
  onReload,
}: UpdateProgressModalProps): React.ReactElement {
  const t = useTranslations('adminUpdate.progress');
  const now = useNow(1000);
  const dialogRef = useRef<HTMLDivElement>(null);

  const terminal = outcome !== 'running';
  // The sidecar's view of the job, only when it describes THIS run. Right
  // after a retry the React `status` is still the previous job's snapshot
  // until the next poll lands; reading its phase/trail would show the old
  // rollback for the new run.
  const mine = describesThisRun(status?.executor, inflight);
  const executor = mine ? status?.executor : undefined;
  const sidecarStarted =
    typeof executor?.startedAt === 'string' ? Date.parse(executor.startedAt) : NaN;
  const startedAt = Number.isNaN(sidecarStarted) ? inflight.startedAt : sidecarStarted;
  const elapsed = now - startedAt;
  const stalled = !terminal && elapsed > STALL_AFTER_MS;
  const seconds = (n: number): string => t('seconds', { seconds: n });

  const phase = executor?.phase ?? null;
  const failure = terminal ? (executor?.failure ?? null) : null;
  const steps = stepStates(phase, failure, terminal, outcome === 'failed');
  const rollingBack = phase === 'rollback' && !terminal;

  const reachable =
    polling.lastOkAt !== null &&
    (polling.lastAttemptAt === null || polling.lastOkAt >= polling.lastAttemptAt);
  const sinceOk = polling.lastOkAt === null ? null : now - polling.lastOkAt;

  const decoded = terminal && outcome !== 'succeeded'
    ? decodeFailure(executor?.failure, executor?.error)
    : null;

  // Focus the dialog on open; Escape is deliberately inert while running.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && terminal) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [terminal, onClose]);

  const title =
    outcome === 'succeeded' ? t('titleSucceeded', { version: inflight.target })
    : outcome === 'rolled_back' ? t('titleRolledBack', { version: inflight.target })
    : outcome === 'failed' ? t('titleFailed', { version: inflight.target })
    : rollingBack ? t('titleRollingBack', { version: inflight.target })
    : t('titleRunning', { version: inflight.target });

  const edgeClass =
    outcome === 'rolled_back' || outcome === 'failed'
      ? 'border-[color:var(--danger-edge)]'
      : outcome === 'succeeded'
        ? 'border-[color:var(--success)]/60'
        : 'border-[color:var(--accent)]/50';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-progress-title"
      aria-busy={!terminal}
      data-testid="update-progress-modal"
      data-outcome={outcome}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[color:var(--bg-modal-overlay)] backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`relative z-10 flex max-h-[85vh] w-full max-w-xl flex-col gap-5 overflow-y-auto rounded-lg border bg-[color:var(--card)] p-6 shadow-lg outline-none ${edgeClass}`}
      >
        <header>
          <p className="text-[10px] font-semibold tracking-wider text-[color:var(--fg-muted)] uppercase">
            {t('kicker')}
          </p>
          <h2
            id="update-progress-title"
            className="mt-1 font-display text-2xl leading-tight text-[color:var(--fg-strong)]"
          >
            {title}
          </h2>
          <p className="mt-1 font-mono text-xs text-[color:var(--fg-muted)]">
            {inflight.previous ?? '?'} → {inflight.target}
            <span className="mx-2" aria-hidden="true">·</span>
            <span>{t('elapsed', { elapsed: formatElapsed(elapsed, seconds) })}</span>
          </p>
        </header>

        <ol className="flex w-full flex-col gap-1.5 text-sm" aria-label={t('stepsLabel')}>
          {UPDATE_STEPS.map((step) => {
            const state = steps[step];
            return (
              <li
                key={step}
                data-step={step}
                data-state={state}
                className={`grid grid-cols-[1rem_minmax(0,1fr)] items-baseline gap-x-3 ${STEP_CLASS[state]}`}
              >
                <span className="font-mono" aria-hidden="true">{STEP_GLYPH[state]}</span>
                <span className="min-w-0 break-words">
                  <span className={state === 'current' ? 'lume-busy-dots' : undefined}>
                    {t(`steps.${step}`)}
                  </span>
                  {state === 'current' && step === 'replace' && (
                    <span className="ml-2 text-xs text-[color:var(--fg-muted)]">
                      {t('replaceHint')}
                    </span>
                  )}
                  {state === 'current' && step === 'health_gate' && (
                    <span className="ml-2 text-xs text-[color:var(--fg-muted)]">
                      {t('healthGateHint')}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
          {(rollingBack || outcome === 'rolled_back') && (
            <li
              data-step="rollback"
              data-state={outcome === 'rolled_back' ? 'done' : 'current'}
              className="grid grid-cols-[1rem_minmax(0,1fr)] items-baseline gap-x-3 text-[color:var(--danger)]"
            >
              <span className="font-mono" aria-hidden="true">
                {outcome === 'rolled_back' ? '↩' : '›'}
              </span>
              <span className={`min-w-0 break-words ${rollingBack ? 'lume-busy-dots' : ''}`}>
                {t('steps.rollback', { version: inflight.previous ?? '?' })}
              </span>
            </li>
          )}
          {phase === null && !terminal && (
            <li className="col-span-2 text-xs text-[color:var(--fg-muted)]">{t('noPhaseYet')}</li>
          )}
        </ol>

        {!terminal && (
          <section
            aria-live="polite"
            data-testid="polling-indicator"
            data-reachable={reachable}
            className="rounded border border-[color:var(--border)] px-3 py-2 text-xs text-[color:var(--fg-muted)]"
          >
            <p className="flex flex-wrap items-baseline gap-x-3">
              <span className="lume-busy-dots">
                {t('pollingEvery', { seconds: Math.round(polling.intervalMs / 1000) })}
              </span>
              <span className="font-mono">{t('pollingAttempts', { count: polling.attempts })}</span>
              {sinceOk !== null && (
                <span className="font-mono">
                  {t('pollingLastAnswer', { elapsed: formatElapsed(sinceOk, seconds) })}
                </span>
              )}
            </p>
            <p className={`mt-1 ${reachable ? '' : 'text-[color:var(--warning)]'}`}>
              {reachable ? t('middlewareReachable') : t('middlewareUnreachable')}
            </p>
          </section>
        )}

        {stalled && (
          <section className="rounded border border-[color:var(--warning)]/60 px-3 py-2 text-sm">
            <p className="font-medium">{t('stalledTitle')}</p>
            <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('stalledBody')}</p>
          </section>
        )}

        {outcome === 'succeeded' && (
          <section className="text-sm">
            <p>{t('succeededBody', { version: inflight.target })}</p>
            <p className="mt-1 text-xs text-[color:var(--fg-muted)]">{t('succeededReloadHint')}</p>
          </section>
        )}

        {decoded !== null && (
          <section
            data-testid="failure-explanation"
            data-failure-kind={decoded.kind}
            className="rounded border border-[color:var(--danger-edge)] px-3 py-3 text-sm"
          >
            <p className="font-medium text-[color:var(--danger)]">
              {decoded.kind === 'never_reachable' && t('failure.neverReachable.title')}
              {decoded.kind === 'version_never_matched' &&
                t('failure.versionNeverMatched.title', { observed: decoded.observedVersion })}
              {decoded.kind === 'replace' &&
                t('failure.replace.title', { service: decoded.service ?? '?' })}
              {decoded.kind === 'unknown' && t('failure.unknown.title')}
            </p>
            <p className="mt-1 text-[color:var(--fg-muted)]">
              {outcome === 'rolled_back'
                ? t('failure.rolledBackBody', { version: inflight.previous ?? '?' })
                : t('failure.notRolledBackBody')}
            </p>
            {decoded.kind === 'never_reachable' && (
              <>
                <p className="mt-2">{t('failure.neverReachable.body')}</p>
                <ul className="mt-1 list-disc pl-5 text-[color:var(--fg-muted)]">
                  <li>{t('failure.neverReachable.causeSecret')}</li>
                  <li>{t('failure.neverReachable.causeMigration')}</li>
                  <li>{t('failure.neverReachable.causeLogs')}</li>
                </ul>
              </>
            )}
            {decoded.kind === 'version_never_matched' && (
              <p className="mt-2">{t('failure.versionNeverMatched.body')}</p>
            )}
            {decoded.kind === 'replace' && (
              <p className="mt-2">{t('failure.replace.body')}</p>
            )}
            {decoded.kind === 'unknown' && decoded.message.length > 0 && (
              <pre className="mt-2 overflow-x-auto rounded bg-[color:var(--bg)] p-2 font-mono text-xs">
                {decoded.message}
              </pre>
            )}
            <p className="mt-2 text-xs">
              <a
                href={DOCS_UPGRADING_URL}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted"
              >
                {t('failure.docsLink')}
              </a>
            </p>
          </section>
        )}

        {(executor?.steps ?? []).length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-[color:var(--fg-muted)]">
              {t('trailTitle', { count: executor?.steps?.length ?? 0 })}
            </summary>
            <ol className="mt-2 max-h-40 overflow-y-auto font-mono text-[11px] text-[color:var(--fg-muted)]">
              {(executor?.steps ?? []).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </details>
        )}

        <footer className="flex items-center justify-end gap-2">
          {stalled && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('dismissStalled')}
            </Button>
          )}
          {outcome === 'succeeded' && (
            <Button variant="primary" size="sm" onClick={onReload}>
              {t('reload')}
            </Button>
          )}
          {terminal && (
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('close')}
            </Button>
          )}
          {!terminal && !stalled && (
            <span className="text-xs text-[color:var(--fg-muted)]">{t('cannotClose')}</span>
          )}
        </footer>
      </div>
    </div>
  );
}
