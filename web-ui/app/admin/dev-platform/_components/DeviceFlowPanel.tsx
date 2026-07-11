'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { deviceConnectPoll, deviceConnectStart } from '../_lib/api';

/**
 * Epic #470 W0 — GitHub device-flow run state (UI spec §3). No spinner anywhere:
 * the user code is the focal object and the polling state is carried by the
 * status line's TEXT (plus `.lume-busy-dots`), announced through an
 * `aria-live="polite"` region (§13). Poll ticks change text only. On success we
 * hand the login back to the wizard, which stages the token server-side.
 */

type Phase = 'starting' | 'waiting' | 'authorized' | 'expired' | 'error';

export function DeviceFlowPanel({
  onAuthorized,
}: {
  onAuthorized: (login: string | null) => void;
}): React.ReactElement {
  const t = useTranslations('adminDevPlatform.wizard.credentials.device');
  const [phase, setPhase] = useState<Phase>('starting');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [login, setLogin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const intervalRef = useRef(5);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The poll self-schedules through a ref so the callback never has to
  // reference itself before its own declaration (react-hooks/immutability).
  const pollRef = useRef<() => void>(() => {});

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const schedulePoll = useCallback(() => {
    pollTimer.current = setTimeout(() => pollRef.current(), intervalRef.current * 1000);
  }, []);

  const poll = useCallback(() => {
    void (async () => {
      try {
        const res = await deviceConnectPoll();
        if (res.status === 'authorized') {
          stopPolling();
          setLogin(res.login ?? null);
          setPhase('authorized');
          onAuthorized(res.login ?? null);
          return;
        }
        if (res.status === 'expired') {
          stopPolling();
          setPhase('expired');
          return;
        }
        if (res.status === 'denied' || res.status === 'error') {
          stopPolling();
          setPhase('error');
          return;
        }
        if (typeof res.interval === 'number' && res.interval > 0) intervalRef.current = res.interval;
        schedulePoll();
      } catch {
        stopPolling();
        setPhase('error');
      }
    })();
  }, [onAuthorized, schedulePoll, stopPolling]);

  useEffect(() => {
    pollRef.current = poll;
  });

  const start = useCallback(() => {
    setPhase('starting');
    setCopied(false);
    void (async () => {
      try {
        const res = await deviceConnectStart();
        setUserCode(res.userCode);
        setVerificationUri(res.verificationUri);
        intervalRef.current = res.interval > 0 ? res.interval : 5;
        setPhase('waiting');
        schedulePoll();
      } catch {
        setPhase('error');
      }
    })();
  }, [schedulePoll]);

  useEffect(() => {
    start();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  const copyCode = useCallback(() => {
    void navigator.clipboard?.writeText(userCode).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, [userCode]);

  return (
    <div className="mt-4">
      <div className="flex items-center gap-3">
        <div
          className="rounded-md border border-[color:var(--border-strong)] px-4 py-3 font-mono text-2xl tracking-[0.3em] text-[color:var(--fg-strong)]"
          aria-label={t('codeAria', { code: userCode })}
        >
          {userCode || '········'}
        </div>
        <Button variant="ghost" size="sm" onClick={copyCode} disabled={!userCode}>
          {copied ? t('copied') : t('copyCode')}
        </Button>
      </div>
      {verificationUri ? (
        <a
          href={verificationUri}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-sm text-[color:var(--accent)] underline"
        >
          {verificationUri}
        </a>
      ) : null}
      <p aria-live="polite" className="mt-3 text-sm">
        {phase === 'waiting' || phase === 'starting' ? (
          <span className="text-[color:var(--fg)]">
            {t('waiting')}
            <span className="lume-busy-dots" aria-hidden />
          </span>
        ) : null}
        {phase === 'authorized' ? (
          <span className="text-[color:var(--success)]">{t('authorizedAs', { login: login ?? '' })}</span>
        ) : null}
        {phase === 'expired' ? <span className="text-[color:var(--danger)]">{t('expired')}</span> : null}
        {phase === 'error' ? <span className="text-[color:var(--danger)]">{t('error')}</span> : null}
      </p>
      {phase === 'expired' || phase === 'error' ? (
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={start}>
            {t('restart')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
