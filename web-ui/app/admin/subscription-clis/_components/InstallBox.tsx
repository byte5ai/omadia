'use client';

/**
 * In-app runtime CLI install (#294 enabler) + the manual install steps.
 *
 * Extracted from `SubscriptionClisPanel.tsx` to keep that file within the
 * workspace size rule. The public image does not bundle the vendor CLIs, so
 * "not installed" used to dead-end in manual shell steps (OM-11). For
 * installable backends `InstallBox` triggers the backend's npm install into
 * the persisted tools dir and polls until it lands; the manual steps stay one
 * click away for operators who prefer the terminal.
 */
import { useEffect, useState } from 'react';
import type { useTranslations } from 'next-intl';

import { ErrorHelp } from '../../../_components/ErrorHelp';
import { Button } from '../../../_components/ui/Button';
import {
  ApiError,
  getCliInstallStatus,
  startCliInstall,
  type CliBackendStatus,
} from '../../../_lib/api';

type T = ReturnType<typeof useTranslations>;

/**
 * OM-11 — the "how do I get this CLI onto the server" steps.
 *
 * Rendered in three places: collapsed inside the connect box (CLI present,
 * operator prefers the terminal), collapsed under the install button
 * (installable CLI absent), and expanded on its own when the CLI is absent
 * and not installable from here.
 */
export function ManualInstallSteps({
  b,
  cliToolsDir,
  t,
}: {
  b: CliBackendStatus;
  cliToolsDir: string;
  t: T;
}): React.ReactElement {
  return (
    <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[color:var(--fg-muted)]">
      <li>
        {t('connect.step1')}{' '}
        <code className="select-all text-[color:var(--fg-strong)]">
          {t('connect.installCmd', { prefix: cliToolsDir })}
        </code>
      </li>
      <li>
        {t('connect.step2')}{' '}
        <code className="select-all text-[color:var(--fg-strong)]">
          {t('connect.loginCmd', { bin: b.bin })}
        </code>
      </li>
      <li>{t('connect.step3')}</li>
    </ol>
  );
}

type InstallPhase =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'running' }
  | { phase: 'failed'; code?: string; detail?: string; logTail?: string };

/** How often the panel asks the backend whether a running install finished. */
const INSTALL_POLL_INTERVAL_MS = 3000;
/** Stop polling after this many consecutive errors (e.g. an expired session). */
const MAX_POLL_FAILURES = 5;

function combineInstallDetail(
  detail?: string,
  logTail?: string,
): string | undefined {
  if (detail && logTail) {
    return detail === logTail ? detail : `${detail}\n\n${logTail}`;
  }
  return detail ?? logTail;
}

export function InstallBox({
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
  const [phase, setPhase] = useState<InstallPhase>({ phase: 'idle' });

  useEffect(() => {
    if (phase.phase !== 'running') return;
    let cancelled = false;
    let failures = 0;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const s = await getCliInstallStatus(b.id);
          if (cancelled) return;
          failures = 0;
          if (s.status === 'succeeded') {
            clearInterval(timer);
            onChanged();
          } else if (s.status === 'failed') {
            clearInterval(timer);
            setPhase({
              phase: 'failed',
              ...(s.code ? { code: s.code } : {}),
              ...(s.error ? { detail: s.error } : {}),
              ...(s.logTail ? { logTail: s.logTail } : {}),
            });
          } else if (s.status === 'idle') {
            // Backend restarted mid-install — offer the button again.
            clearInterval(timer);
            setPhase({ phase: 'idle' });
          }
        } catch {
          // Transient poll error — retry, but never poll a dead session forever.
          failures += 1;
          if (failures >= MAX_POLL_FAILURES && !cancelled) {
            clearInterval(timer);
            setPhase({ phase: 'failed' });
          }
        }
      })();
    }, INSTALL_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase.phase, b.id, onChanged]);

  const onInstall = async (): Promise<void> => {
    setPhase({ phase: 'starting' });
    try {
      const res = await startCliInstall(b.id);
      if (res.alreadyInstalled) {
        onChanged();
        setPhase({ phase: 'idle' });
      } else {
        setPhase({ phase: 'running' });
      }
    } catch (err) {
      // 409 = another install is running host-wide — say so, don't just "failed".
      const detail =
        err instanceof ApiError && err.status === 409
          ? t('install.conflict')
          : err instanceof Error
            ? err.message
            : String(err);
      setPhase({ phase: 'failed', detail });
    }
  };

  return (
    <div>
      <p className="mt-2 text-sm text-[color:var(--fg-muted)]">{t('install.autoIntro')}</p>

      {(phase.phase === 'idle' || phase.phase === 'failed') && (
        <div className="mt-3">
          <Button variant="primary" size="sm" onClick={() => void onInstall()}>
            {phase.phase === 'failed' ? t('install.retry') : t('install.button')}
          </Button>
        </div>
      )}

      {(phase.phase === 'starting' || phase.phase === 'running') && (
        <p className="mt-3 text-sm text-[color:var(--fg-muted)]" data-testid="cli-install-running">
          {t('install.installing')}
        </p>
      )}

      {phase.phase === 'failed' && (
        <div className="mt-3">
          <ErrorHelp
            code={phase.code ?? null}
            rawDetail={combineInstallDetail(phase.detail, phase.logTail)}
            fallback={t('install.failed')}
          />
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-[12px] text-[color:var(--fg-muted)]">
          {t('install.manualSummary')}
        </summary>
        <ManualInstallSteps b={b} cliToolsDir={cliToolsDir} t={t} />
      </details>
    </div>
  );
}
