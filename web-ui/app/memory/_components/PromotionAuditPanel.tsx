'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import {
  ApiError,
  listMemoryPromotions,
  type MemoryPromotionReceipt,
} from '@/app/_lib/api';

/**
 * Audit tab — renders /memories/core/audit/memory-promotions.jsonl for one
 * agent (design #870 §6). The JSONL lives in the `core` namespace so the agent
 * can read its own promotion history; the operator gets it here, newest first.
 */

const AUDIT_LIMIT = 100;

export interface PromotionAuditPanelProps {
  agentSlug: string | null;
  /** Bumped by the page after a successful promote to force a refetch. */
  reloadToken: number;
}

export function PromotionAuditPanel({
  agentSlug,
  reloadToken,
}: PromotionAuditPanelProps): React.ReactElement {
  const t = useTranslations('memory.audit');
  const format = useFormatter();
  const [entries, setEntries] = useState<MemoryPromotionReceipt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (slug: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res = await listMemoryPromotions(slug, { limit: AUDIT_LIMIT });
        setEntries(res.entries);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setError(t('unavailable'));
        } else if (err instanceof ApiError && err.status === 403) {
          setError(t('forbidden'));
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (agentSlug === null) return;
    // Load-on-change: `load` marks the panel busy (one intended render) before
    // fetching — not a cascading-render anti-pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(agentSlug);
  }, [agentSlug, reloadToken, load]);

  if (agentSlug === null) {
    return (
      <div className="px-6 py-4 text-xs text-[color:var(--fg-muted)]">
        {t('selectAgent')}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
      {loading && (
        <p className="text-xs text-[color:var(--fg-muted)]">{t('loading')}</p>
      )}
      {error !== null && (
        <p className="border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
          {error}
        </p>
      )}
      {!loading && error === null && entries.length === 0 && (
        <p className="text-xs text-[color:var(--fg-muted)]">{t('empty')}</p>
      )}
      {entries.length > 0 && (
        <ul className="flex flex-col gap-2">
          {entries.map((e, i) => (
            <li
              key={`${e.ts}-${String(i)}`}
              className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[color:var(--fg-muted)]">
                  {format.dateTime(new Date(e.ts), {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </span>
                <span className="rounded bg-[color:var(--bg-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                  {t(`mode.${e.mode}`)}
                </span>
                <span className="text-[color:var(--fg)]">{e.actor}</span>
                <span className="ml-auto text-[10px] text-[color:var(--fg-subtle)]">
                  {t('bytes', { bytes: e.bytes })}
                </span>
              </div>
              <div className="mt-1 break-all font-mono text-[10px] text-[color:var(--fg-muted)]">
                {e.sourcePath} → {e.targetPath}
              </div>
              <p className="mt-1 text-[11px] text-[color:var(--fg)]">
                {e.reason !== undefined && e.reason.length > 0
                  ? e.reason
                  : t('noReason')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
