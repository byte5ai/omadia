'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import type { MemorableKind } from '../../_lib/api';

interface Props {
  /** External_id of the auto-promoted MK (e.g. `mk:<uuid>`). */
  mkId: string;
  /** Kind the MK was saved as. Read from the same palaiaExcerpt the
   *  orchestrator used; the auto-promoter's fallback is 'insight'. */
  kind: MemorableKind;
  /** Called when the user successfully Discards the MK so the parent
   *  can clear `autoPromotedMkId` from the message and re-enable the
   *  manual save-as-memory button. */
  onDiscarded: () => void;
}

/**
 * Slice 4c — inline status row that replaces the save-as-memory button
 * on a turn that Palaia auto-promoted. Tells the user it happened,
 * deep-links to /memories for ownership/audit edits, and offers a
 * one-click Discard that hits DELETE /api/v1/memory/:id and falls
 * back to the manual save flow.
 *
 * Edit is intentionally a deep-link rather than an inline modal: a
 * dedicated PATCH endpoint for MK content (kind/summary/rationale)
 * does not exist yet. The /memories list shows the freshly-promoted
 * entry at the top and the Slice-3 ACL detail panel lets the owner
 * adjust ACL + delete; richer content-edit is its own follow-up.
 */
export function AutoPromotedBanner({
  mkId,
  kind,
  onDiscarded,
}: Props): React.ReactElement {
  const t = useTranslations('chat.autoPromoted');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discard = useCallback(async (): Promise<void> => {
    if (!window.confirm(t('discardConfirm'))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/bot-api/v1/memory/${encodeURIComponent(mkId)}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'discarded-from-chat' }),
        },
      );
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => ({}))) as {
          code?: string;
        };
        throw new Error(body.code ?? `HTTP ${String(res.status)}`);
      }
      onDiscarded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [mkId, t, onDiscarded]);

  return (
    <span className="ml-3 inline-flex items-center gap-2 rounded border border-green-300 bg-green-50 px-2 py-0.5 text-[11px] text-green-800 dark:border-green-800 dark:bg-green-900/30 dark:text-green-200">
      <span aria-hidden>✓</span>
      <span>{t('label', { kind: t(`kind.${kind}`) })}</span>
      <span className="font-mono text-[10px] opacity-60" title={mkId}>
        {mkId.length > 12 ? `${mkId.slice(0, 12)}…` : mkId}
      </span>
      <a
        href={`/memories/${encodeURIComponent(mkId)}`}
        className="rounded border border-green-300 px-1 py-0.5 text-[10px] hover:bg-green-100 dark:border-green-700 dark:hover:bg-green-900/40"
        title={t('viewTitle')}
      >
        {t('view')}
      </a>
      <button
        type="button"
        onClick={() => void discard()}
        disabled={busy}
        className="rounded border border-red-300 px-1 py-0.5 text-[10px] text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30"
        title={t('discardTitle')}
      >
        {busy ? t('discarding') : t('discard')}
      </button>
      {error !== null && (
        <span className="text-red-600 dark:text-red-400">⚠ {error}</span>
      )}
    </span>
  );
}
