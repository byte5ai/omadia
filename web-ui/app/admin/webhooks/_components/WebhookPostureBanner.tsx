'use client';

import { useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { ApiError, getWebhookPosture, type ConductorWebhookPosture } from '@/app/_lib/api';

import { WebhookError, toFriendlyError, type FriendlyWebhookError } from './shared';

/**
 * Issue #1707 — the kill switch was invisible. With `CONDUCTOR_WEBHOOKS_ENABLED=false`
 * every inbound request was answered `200 {"outcome":"disabled"}`: senders saw
 * success, the middleware log still printed its usual "inbound router mounted" line,
 * and this admin page showed no state at all — so an operator could configure
 * endpoints here, watch senders report 200, and never learn that nothing was being
 * processed.
 *
 * The banner is the page's first element and it is LOUD when inbound is off, because
 * every endpoint listed below it is inert in that state. When inbound is on it stays
 * quiet and just states the hardening windows in force, so the page answers "what is
 * enforced here" without an operator reading the server's env.
 *
 * A failed posture read renders the error rather than nothing: "we could not tell you
 * whether webhooks are on" is itself information — except for a 404, which is not a
 * failure at all (see `load`).
 */

/** The posture of an install that has no Conductor wiring. Mirrors what the route
 *  itself answers when it is mounted without the stores, so both ways of reaching
 *  "there is no webhook surface here" render the identical banner. */
const NOT_CONFIGURED: ConductorWebhookPosture = { configured: false, inboundEnabled: false };
export function WebhookPostureBanner(): React.ReactElement {
  const t = useTranslations('adminWebhooks.posture');
  const tErr = useTranslations('adminWebhooks');
  const [posture, setPosture] = useState<ConductorWebhookPosture | null>(null);
  const [error, setError] = useState<FriendlyWebhookError | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await getWebhookPosture();
      setPosture(res.posture);
    } catch (err) {
      // A 404 is not a failure here (#1707 review finding). The whole Conductor
      // operator router is mounted only when a Postgres pool exists, so on a DB-less
      // install this path does not exist and the route's own `configured: false`
      // answer is unreachable — leaving the operator with a red "request failed" line
      // where the honest answer is "this server has no webhook surface". Same banner
      // either way.
      if (err instanceof ApiError && err.status === 404) {
        setPosture(NOT_CONFIGURED);
        return;
      }
      setError(toFriendlyError(err, tErr));
    }
  }, [tErr]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (error) return <WebhookError error={error} className="mb-6" />;
  if (!posture) return <p className="mb-6 text-sm opacity-70">{t('loading')}</p>;

  if (!posture.inboundEnabled) {
    return (
      <div
        className="mb-6 rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 p-4"
        role="status"
      >
        <p className="text-[14px] font-semibold text-[color:var(--danger)]">{t('inboundOff')}</p>
        <p className="mt-1 text-[13px] text-[color:var(--fg-muted)]">
          {posture.configured ? t('inboundOffDetail') : t('notConfiguredDetail')}
        </p>
      </div>
    );
  }

  const facts = [
    t('factTimestamp', {
      seconds: posture.timestampToleranceSeconds ?? 0,
      mode: posture.requireTimestamp === true ? t('timestampRequired') : t('timestampOptional'),
    }),
    t('factGrace', { seconds: posture.secretGraceSeconds ?? 0 }),
    t('factRetention', {
      payloadDays: posture.payloadRetentionDays ?? 0,
      deliveryDays: posture.deliveryRetentionDays ?? 0,
    }),
    t('factRateLimit', { perMinute: posture.maxInboundDeliveriesPerMinute ?? 0 }),
  ];

  return (
    <div className="mb-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4" role="status">
      <p className="text-[14px] font-semibold text-[color:var(--success)]">{t('inboundOn')}</p>
      <ul className="mt-2 flex flex-col gap-1 text-[13px] text-[color:var(--fg-muted)]">
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    </div>
  );
}
