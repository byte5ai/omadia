'use client';

/**
 * "Sign in with ChatGPT" device-code modal (#294, EXPERIMENTAL).
 *
 * Drives the provider OAuth device flow: start → show the user code + a link to
 * the verification page → poll on the server-supplied interval until the login
 * completes, expires, or errors. Surfaces a prominent ToS / experimental notice
 * because driving programmatic calls through a consumer ChatGPT subscription is
 * a grey area of OpenAI's terms.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  pollProviderOAuth,
  startProviderOAuth,
  type ProviderOAuthStart,
} from '../../../_lib/api';

type T = ReturnType<typeof useTranslations>;

type Phase =
  | { phase: 'starting' }
  | { phase: 'awaiting'; start: ProviderOAuthStart }
  | { phase: 'done' }
  | { phase: 'expired' }
  | { phase: 'error'; detail?: string };

/** Fallback poll cadence if the server does not supply one (seconds). */
const DEFAULT_INTERVAL_S = 5;

export function ChatGptConnectModal({
  providerId,
  t,
  onClose,
  onConnected,
}: {
  providerId: string;
  t: T;
  onClose: () => void;
  onConnected: () => void;
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ phase: 'starting' });
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const beginFlow = useCallback(async () => {
    setPhase({ phase: 'starting' });
    try {
      const start = await startProviderOAuth(providerId);
      if (cancelled.current) return;
      setPhase({ phase: 'awaiting', start });
    } catch (err) {
      if (!cancelled.current) {
        setPhase({ phase: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [providerId]);

  useEffect(() => {
    void beginFlow();
  }, [beginFlow]);

  // Poll while awaiting approval.
  useEffect(() => {
    if (phase.phase !== 'awaiting') return;
    const intervalMs = (phase.start.interval || DEFAULT_INTERVAL_S) * 1000;
    let active = true;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await pollProviderOAuth(phase.start.flowId);
          if (!active || cancelled.current) return;
          if (res.status === 'complete') {
            clearInterval(timer);
            setPhase({ phase: 'done' });
            onConnected();
          } else if (res.status === 'expired') {
            clearInterval(timer);
            setPhase({ phase: 'expired' });
          } else if (res.status === 'error') {
            clearInterval(timer);
            setPhase({ phase: 'error' });
          }
          // 'pending' → keep polling.
        } catch (err) {
          if (!active || cancelled.current) return;
          clearInterval(timer);
          setPhase({ phase: 'error', detail: err instanceof Error ? err.message : String(err) });
        }
      })();
    }, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [phase, onConnected]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('oauth.title')}
    >
      <div className="w-full max-w-md rounded-xl border border-[color:var(--border)] bg-[color:var(--card)] p-6 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[16px] font-semibold text-[color:var(--fg-strong)]">
            {t('oauth.title')}
          </h2>
          {/* eslint-disable-next-line no-restricted-syntax -- icon-only close chrome, no §4.2 variant */}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('oauth.close')}
            className="text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
          >
            ✕
          </button>
        </div>

        {/* ToS / experimental caveat — always visible. */}
        <p className="mt-3 rounded-md border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-3 py-2 text-[12px] text-[color:var(--warning)]">
          {t('oauth.tosNotice')}
        </p>

        {phase.phase === 'starting' && (
          <p className="mt-4 text-sm text-[color:var(--fg-muted)]">{t('oauth.starting')}</p>
        )}

        {phase.phase === 'awaiting' && (
          <div className="mt-4">
            <ol className="list-decimal space-y-3 pl-5 text-sm text-[color:var(--fg-muted)]">
              <li>
                {t('oauth.openHint')}{' '}
                <a
                  href={phase.start.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all font-medium text-[color:var(--accent)] underline"
                >
                  {t('oauth.openLink')}
                </a>
              </li>
              <li>
                {t('oauth.enterCode')}
                <div
                  className="mt-2 select-all rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2 text-center text-[20px] font-semibold tracking-[0.2em] text-[color:var(--fg-strong)]"
                  data-testid="oauth-user-code"
                >
                  {phase.start.userCode}
                </div>
              </li>
              <li>{t('oauth.waiting')}</li>
            </ol>
          </div>
        )}

        {phase.phase === 'done' && (
          <p className="mt-4 text-sm text-[color:var(--success)]">{t('oauth.connected')}</p>
        )}

        {phase.phase === 'expired' && (
          <div className="mt-4">
            <p className="text-sm text-[color:var(--danger)]">{t('oauth.expired')}</p>
            <div className="mt-3">
              <Button variant="primary" size="sm" onClick={() => void beginFlow()}>
                {t('oauth.retry')}
              </Button>
            </div>
          </div>
        )}

        {phase.phase === 'error' && (
          <div className="mt-4">
            <p className="text-sm text-[color:var(--danger)]">{t('oauth.failed')}</p>
            {phase.detail ? (
              <p className="mt-1 text-[12px] text-[color:var(--fg-muted)]">{phase.detail}</p>
            ) : null}
            <div className="mt-3">
              <Button variant="primary" size="sm" onClick={() => void beginFlow()}>
                {t('oauth.retry')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
