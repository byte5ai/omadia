'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PluginActionStatus } from '../../_lib/storeTypes';

/**
 * Spec 004 — operator-action banner on the plugin detail page. Seeded with the
 * server-rendered status, then polls the store detail endpoint so it
 * auto-clears the moment the plugin reports `ok` (e.g. after the operator
 * connects via the admin UI embedded right below). Renders nothing when there
 * is no pending action — so a healthy plugin shows no banner.
 */
export function ActionStatusBanner({
  pluginId,
  initial,
}: {
  pluginId: string;
  initial?: PluginActionStatus;
}): React.ReactElement | null {
  const t = useTranslations('store.actionStatus');
  const [status, setStatus] = useState<PluginActionStatus | undefined>(initial);

  useEffect(() => {
    let alive = true;
    const url = `/bot-api/v1/store/plugins/${encodeURIComponent(pluginId)}`;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as {
          plugin?: { action_status?: PluginActionStatus };
        };
        if (alive) setStatus(data.plugin?.action_status);
      } catch {
        // transient — keep the last known status, try again next tick
      }
    };
    const timer = setInterval(poll, 15_000);
    void poll();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pluginId]);

  if (!status || status.state === 'ok') return null;

  const isError = status.state === 'error';
  return (
    <div
      role="status"
      className={
        isError
          ? 'mb-6 flex items-start gap-3 rounded-lg border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/8 p-4'
          : 'mb-6 flex items-start gap-3 rounded-lg border border-[color:var(--warning)]/30 bg-[color:var(--warning)]/8 p-4'
      }
    >
      <AlertTriangle
        className={
          isError
            ? 'mt-0.5 size-5 shrink-0 text-[color:var(--danger)]'
            : 'mt-0.5 size-5 shrink-0 text-[color:var(--warning)]'
        }
        aria-hidden
      />
      <div className="min-w-0">
        <p className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {status.title ?? (isError ? t('errorTitle') : t('actionRequired'))}
        </p>
        {status.detail ? (
          <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
            {status.detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}
