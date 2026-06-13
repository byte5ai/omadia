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
    <span className="ml-3 inline-flex items-center gap-2 rounded border border-[color:var(--success)] bg-[color:var(--success)]/10 px-2 py-0.5 text-[11px] text-[color:var(--success)]">
      <span aria-hidden>✓</span>
      <span>{t('label', { kind: t(`kind.${kind}`) })}</span>
      <span className="font-mono text-[10px] opacity-60" title={mkId}>
        {mkId.length > 12 ? `${mkId.slice(0, 12)}…` : mkId}
      </span>
      <a
        href={`/memories/${encodeURIComponent(mkId)}`}
        className="rounded border border-[color:var(--success)] px-1 py-0.5 text-[10px] hover:bg-[color:var(--success)]/10"
        title={t('viewTitle')}
      >
        {t('view')}
      </a>
      <button
        type="button"
        onClick={() => void discard()}
        disabled={busy}
        className="rounded border border-[color:var(--danger-edge)] px-1 py-0.5 text-[10px] text-[color:var(--danger)] hover:bg-[color:var(--danger)]/8 disabled:opacity-50"
        title={t('discardTitle')}
      >
        {busy ? t('discarding') : t('discard')}
      </button>
      {error !== null && (
        <span className="text-[color:var(--danger)]">⚠ {error}</span>
      )}
    </span>
  );
}
