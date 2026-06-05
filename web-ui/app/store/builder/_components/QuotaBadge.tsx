import { getTranslations } from 'next-intl/server';

import type { DraftQuotaSnapshot } from '../../../_lib/builderTypes';
import { cn } from '../../../_lib/cn';

/**
 * Compact draft-quota readout for the builder dashboard header.
 *
 * Visual escalation:
 *   green  < warnAt         "5 / 50"
 *   amber  warnAt..cap-1    "42 / 50 — bald voll"
 *   red    cap               "50 / 50 — Limit erreicht"
 */
export async function QuotaBadge({
  quota,
}: {
  quota: DraftQuotaSnapshot;
}): Promise<React.ReactElement> {
  const t = await getTranslations('builder.drafts.quota');
  const tone: 'ok' | 'warn' | 'full' = quota.exceeded
    ? 'full'
    : quota.warning
      ? 'warn'
      : 'ok';

  const label = quota.exceeded
    ? t('limitReached')
    : quota.warning
      ? t('almostFull')
      : t('label');

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold',
        tone === 'ok' &&
          'border-[color:var(--divider)] bg-[color:var(--bg-soft)] text-[color:var(--fg-muted)]',
        tone === 'warn' &&
          'border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 text-[color:var(--warning)]',
        tone === 'full' &&
          'border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 text-[color:var(--danger)]',
      )}
      title={t('tooltip', {
        used: quota.used,
        cap: quota.cap,
        warnAt: quota.warnAt,
      })}
    >
      <span className="font-mono-num tabular-nums">
        {String(quota.used)} / {String(quota.cap)}
      </span>
      <span className="uppercase tracking-[0.14em]">{label}</span>
    </div>
  );
}
