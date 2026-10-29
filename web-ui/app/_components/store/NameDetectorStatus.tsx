'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { UserSearch } from 'lucide-react';

import { cn } from '../../_lib/cn';
import { getPrivacyPosture, type PrivacyNameDetector } from '../../_lib/api';

/**
 * #1562 — state of the Privacy Guard's C1 name detector on the guard's store
 * page. C1 is the only detector that recognises person names in free text;
 * whether it runs used to show only in a boot-log line, and an empty
 * `c1_detector_url` field could mean "off" or "configured via env".
 *
 * Reads `name_detector` from the privacy posture. Renders nothing while
 * loading, on a failed read, or when the backend does not report the field
 * (older middleware, or no shield running).
 */
export function NameDetectorStatus(): React.ReactElement | null {
  const t = useTranslations('privacyNameDetector');
  const format = useFormatter();
  const [detector, setDetector] = useState<PrivacyNameDetector | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPrivacyPosture()
      .then((p) => {
        if (!cancelled) setDetector(p.name_detector ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (detector === null) return null;

  const isActive = detector.state === 'active';
  const stateText =
    detector.state === 'unconfigured'
      ? t('stateOff')
      : detector.state === 'unreachable'
        ? t('stateUnreachable')
        : detector.source === 'setup'
          ? t('stateActiveSetup')
          : detector.source === 'env'
            ? t('stateActiveEnv')
            : t('stateActive');

  return (
    <div
      data-testid="name-detector-status"
      data-state={detector.state}
      className={cn(
        'rounded-md border px-3 py-3',
        isActive
          ? 'border-[color:var(--border)] bg-[color:var(--bg-soft)]'
          : 'border-[color:var(--warning)] bg-[color:var(--warning)]/10',
      )}
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
        <UserSearch className="size-3.5" aria-hidden />
        {t('label')}
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-[color:var(--fg)]">{stateText}</p>
      {detector.prompt_masking === false ? (
        <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--fg-subtle)]">
          {t('promptMaskingOff')}
        </p>
      ) : null}
      {detector.last_failure_at ? (
        <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--fg-subtle)]">
          {t('lastFailure', {
            when: format.dateTime(new Date(detector.last_failure_at), {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })}
        </p>
      ) : null}
    </div>
  );
}
